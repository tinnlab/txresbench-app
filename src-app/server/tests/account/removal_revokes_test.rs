//! H-1 (#147) — **removal revokes access, including to resources the member
//! created.** The A9 deny suite for the `owner_id ==` bypass, plus the
//! no-legitimate-access-lost persona regressions.
//!
//! ## Why every deny here is paired with a positive control
//!
//! "A removed member is refused" passes VACUOUSLY when the fixture is simply
//! broken — a dataset that was never created, an account row that never linked,
//! a user id that never existed all produce the same refusal. So every deny
//! assertion in this file is paired, in the SAME test and on the SAME fixture
//! and through the SAME predicate, with at least one principal who MUST still be
//! admitted:
//!
//! - `alice` — the org's account `owner`, still a member;
//! - `dana` — a bare account `member` who CREATED her own resources in the same
//!   org. Dana is the load-bearing control: she is the exact principal a
//!   careless fix would lock out, because her authority over what she made comes
//!   from the creator branch and NOT from her `member` role's Viewer floor;
//! - and, wherever the predicate allows it, `bob` himself asserted one line
//!   BEFORE the removal, so the same call is shown flipping from admit to refuse
//!   with nothing but the `account_members` DELETE in between.
//!
//! The shared fixture is built by [`Fixture::build`]: an ORG account `Lab` with
//! alice(owner) / bob(member) / dana(member), where **bob** creates project P,
//! dataset D and a job scoped to D, and **dana** creates project Q and dataset E.
//! `remove_bob` then deletes exactly one row — bob's `account_members` row — and
//! nothing else. Every "after" assertion is therefore attributable to that one
//! DELETE.

use std::collections::HashSet;

use cytoanalyst::modules::dataset::repository::{DatasetAccess, DatasetRepository};
use cytoanalyst::modules::jobs::repository::JobRepository;
use cytoanalyst::modules::project::{EffectivePermission, ProjectRepository, ProjectScope};
use cytoanalyst::modules::sandbox::inputs::file_readable_by;
use cytoanalyst::modules::workstore::authz::{
    require_artifact_read, require_dataset_read, require_project_read,
};
use cytoanalyst::modules::workstore::catalog::{Artifact, CatalogRepository, NewArtifact};
use sqlx::SqlitePool;
use uuid::Uuid;

use super::{
    add_member, create_user, make_org_account, move_dataset_to_account, move_project_to_account,
    pool_for, setup_admin,
};
use crate::common::TestServer;

/// The shared H-1 fixture. See the module docs for the principals and why dana
/// exists.
struct Fixture {
    pool: SqlitePool,
    /// the platform admin's bearer token (kept because `login()` uses the
    /// created-user password, which the setup admin does not have).
    admin_token: String,
    org: Uuid,
    /// account `owner`, stays a member — positive control.
    alice: Uuid,
    /// account `member`, CREATES P/D/J, then gets removed — the deny subject.
    bob: Uuid,
    /// account `member`, CREATES Q/E, stays a member — the load-bearing control.
    dana: Uuid,
    /// NOT a member; holds an `edit` SHARE on D — the audience positive control and
    /// the orthogonal share union.
    eve: Uuid,
    /// project created by bob in the org.
    p: Uuid,
    /// project created by dana in the org.
    q: Uuid,
    /// dataset created by bob in the org.
    d: Uuid,
    /// a SECOND dataset created by bob in the org, never foldered.
    d2: Uuid,
    /// dataset created by dana in the org.
    e: Uuid,
    /// a `files` row linked to dataset D (the sandbox-staging subject).
    f: Uuid,
    /// a job scoped to dataset D, owned by ALICE (not bob) — so the job tests
    /// exercise the dataset-owner arm and not the job-creator short-circuit,
    /// which is a separate, filed defect (DEC-8).
    job: Uuid,
    /// a job scoped to PROJECT P, owned by alice — exercises the `p.owner_id`
    /// arms of the jobs predicates (the dataset arms are covered by `job`).
    pjob: Uuid,
    /// alice-owned job scoped to DANA's project Q — the non-confounded PROJECT-arm
    /// positive control (dana owns no job, so her reach can only come from the arm).
    qjob: Uuid,
    /// alice-owned job scoped to DANA's dataset E — the non-confounded DATASET-arm
    /// positive control.
    ejob: Uuid,
    /// an artifact scoped to dataset D.
    artifact: Artifact,
}

impl Fixture {
    async fn build(server: &TestServer) -> Fixture {
        let admin = setup_admin(server).await;
        let alice = create_user(server, &admin, "alice", "alice@x.test").await;
        let bob = create_user(server, &admin, "bob", "bob@x.test").await;
        let dana = create_user(server, &admin, "dana", "dana@x.test").await;
        // NOT an account member — an edit-sharee only (see the share below).
        let eve = create_user(server, &admin, "eve", "eve@x.test").await;
        let pool = pool_for(server).await;

        let org = make_org_account(&pool, "Lab", alice).await;
        add_member(&pool, org, bob, "member").await;
        add_member(&pool, org, dana, "member").await;

        let projects = ProjectRepository::new(pool.clone());
        let datasets = DatasetRepository::new(pool.clone());

        // bob (the soon-to-be-removed member) CREATES these.
        let p = projects.create(bob, "bobs-project", "").await.unwrap().id;
        move_project_to_account(&pool, p, org).await;
        let d = datasets
            .create(bob, "bobs-dataset", None, &serde_json::json!({}))
            .await
            .unwrap()
            .id;
        move_dataset_to_account(&pool, d, org).await;
        // A second bob-owned org dataset, deliberately NEVER foldered: `add_to_folder`
        // reports `true` for an EXISTING membership (its idempotency path), so the
        // folder deny has to be asserted on a dataset that is not in the folder yet.
        let d2 = datasets
            .create(bob, "bobs-dataset-2", None, &serde_json::json!({}))
            .await
            .unwrap()
            .id;
        move_dataset_to_account(&pool, d2, org).await;

        // dana (a bare member who stays) creates the CONTROL resources.
        let q = projects.create(dana, "danas-project", "").await.unwrap().id;
        move_project_to_account(&pool, q, org).await;
        let e = datasets
            .create(dana, "danas-dataset", None, &serde_json::json!({}))
            .await
            .unwrap()
            .id;
        move_dataset_to_account(&pool, e, org).await;

        // A file linked to D — the thing a sandbox would stage.
        let f = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO files (id, user_id, filename, file_size, current_version_id, created_by) \
             VALUES ($1, $2, 'bob.csv', 10, $3, 'user')",
        )
        .bind(f)
        .bind(bob)
        .bind(Uuid::new_v4())
        .execute(&pool)
        .await
        .expect("seed file");
        sqlx::query(
            "INSERT INTO dataset_files (dataset_id, file_id, ordinal, role) \
             VALUES ($1, $2, 0, 'primary')",
        )
        .bind(d)
        .bind(f)
        .execute(&pool)
        .await
        .expect("seed file linked to D");

        // A job scoped to D. Its OWNER is alice, deliberately: the creator
        // short-circuit (`jobs.owner_id`) is a different, filed defect (DEC-8), so
        // making bob the job owner would test that instead of the dataset-owner arm
        // this branch fixes.
        let job = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO jobs (id, owner_id, job_type, name, status, params, created_at, \
                               priority_class, resource_class) \
             VALUES ($1, $2, 'stub', 'j', 'running', '{}', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'normal', 'cpu-sandbox')",
        )
        .bind(job)
        .bind(alice)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO job_scope (job_id, scope_kind, scope_id) VALUES ($1, 'dataset', $2)",
        )
        .bind(job)
        .bind(d)
        .execute(&pool)
        .await
        .unwrap();

        // `eve` is NOT an account member; she holds an EDIT SHARE on D. She exists so
        // TEST-10's audience deny has a real positive control (otherwise it asserts
        // absence from a set that is empty anyway), and so the orthogonal share union
        // is exercised alongside the membership union. Deliberately NOT dana: giving
        // dana a share would confound every DEC-12 floor assertion about her, which
        // is exactly the kind of fixture coupling a deny suite must avoid.
        sqlx::query(
            "INSERT INTO dataset_shares (id, dataset_id, principal_type, principal_id, role) \
             VALUES (randomblob(16), $1, 'user', $2, 'edit')",
        )
        .bind(d)
        .bind(eve)
        .execute(&pool)
        .await
        .expect("share D to eve");

        // A second job, scoped to bob's PROJECT. The three edited jobs predicates
        // each have a dataset arm AND a project arm; without this fixture the project
        // arms could be reverted with the suite still green.
        let pjob = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO jobs (id, owner_id, job_type, name, status, params, created_at, \
                               priority_class, resource_class) \
             VALUES ($1, $2, 'stub', 'pj', 'running', '{}', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'normal', 'cpu-sandbox')",
        )
        .bind(pjob)
        .bind(alice)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO job_scope (job_id, scope_kind, scope_id) VALUES ($1, 'project', $2)",
        )
        .bind(pjob)
        .bind(p)
        .execute(&pool)
        .await
        .unwrap();

        // Two more alice-owned jobs, scoped to DANA's project and dataset. These are
        // the NON-CONFOUNDED positive controls for the two arms: alice owns every job
        // in this fixture, so she is admitted by `jobs.owner_id` alone and would pass
        // with the dataset/project arms DELETED. dana owns no job at all, so her reach
        // over these two can only come from the arms under test.
        let qjob = Uuid::new_v4();
        let ejob = Uuid::new_v4();
        for (jid, kind, scope) in [(qjob, "project", q), (ejob, "dataset", e)] {
            sqlx::query(
                "INSERT INTO jobs (id, owner_id, job_type, name, status, params, created_at, \
                                   priority_class, resource_class) \
                 VALUES ($1, $2, 'stub', 'ctl', 'running', '{}', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'normal', \
                         'cpu-sandbox')",
            )
            .bind(jid)
            .bind(alice)
            .execute(&pool)
            .await
            .unwrap();
            sqlx::query("INSERT INTO job_scope (job_id, scope_kind, scope_id) VALUES ($1, $2, $3)")
                .bind(jid)
                .bind(kind)
                .bind(scope)
                .execute(&pool)
                .await
                .unwrap();
        }

        let catalog = CatalogRepository::new(pool.clone());
        // dana's dataset gets an artifact too — `artifact_summary_rows` only reports
        // datasets that HAVE artifacts, so without this the positive control in
        // TEST-8 would be vacuous (an absent row proves nothing).
        catalog
            .insert_artifact(&NewArtifact {
                project_id: None,
                dataset_id: Some(e),
                run_id: None,
                output_id: "out-e".into(),
                datatype: "matrix".into(),
                object_key: Some("ke".into()),
                is_multifile: false,
                content_hash: "he".into(),
                structure: serde_json::json!({}),
                meta: serde_json::json!({}),
                role: "artifact".into(),
                stored_bytes: 1,
                logical_bytes: None,
                created_by: None,
                hidden: false,
                representation_of: None,
            })
            .await
            .expect("insert artifact for E");
        let artifact = catalog
            .insert_artifact(&NewArtifact {
                project_id: None,
                dataset_id: Some(d),
                run_id: None,
                output_id: "out".into(),
                datatype: "matrix".into(),
                object_key: Some("k".into()),
                is_multifile: false,
                content_hash: "h".into(),
                structure: serde_json::json!({}),
                meta: serde_json::json!({}),
                role: "artifact".into(),
                stored_bytes: 1,
                logical_bytes: None,
                created_by: None,
                hidden: false,
                representation_of: None,
            })
            .await
            .expect("insert artifact");

        Fixture {
            pool,
            admin_token: admin,
            org,
            alice,
            bob,
            dana,
            eve,
            p,
            q,
            d,
            d2,
            e,
            f,
            job,
            pjob,
            qjob,
            ejob,
            artifact,
        }
    }

    /// Delete EXACTLY bob's membership row — the whole offboarding event, and the
    /// only difference between every "before" and "after" assertion in this file.
    async fn remove_bob(&self) {
        let done =
            sqlx::query("DELETE FROM account_members WHERE account_id = $1 AND user_id = $2")
                .bind(self.org)
                .bind(self.bob)
                .execute(&self.pool)
                .await
                .expect("remove bob");
        assert_eq!(
            done.rows_affected(),
            1,
            "the fixture must actually have had bob as a member — otherwise every \
             deny below would pass vacuously"
        );
    }

    fn projects(&self) -> ProjectRepository {
        ProjectRepository::new(self.pool.clone())
    }
    fn datasets(&self) -> DatasetRepository {
        DatasetRepository::new(self.pool.clone())
    }
    fn jobs(&self) -> JobRepository {
        JobRepository::new(self.pool.clone())
    }
}

// ============================ H-1 deny + control ============================

/// TEST-1 [acceptance] [invariant: INV-11] — `effective_permission` + `list_visible`.
///
/// This is the PRIMARY H-1 site: `effective_permission` returned `Owner` on the
/// `projects.owner_id == user` branch BEFORE any membership check ran, so a
/// removed member kept read, write, delete, transfer AND share on every project
/// they had created in the organization.
#[tokio::test]
async fn removed_member_loses_owner_access_to_the_project_they_created() {
    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let projects = fx.projects();

    // BEFORE: bob is the creator AND a member — he is Owner. This is the
    // before-half of the control: the same call must be shown flipping.
    assert_eq!(
        projects.effective_permission(fx.p, fx.bob).await.unwrap(),
        Some(EffectivePermission::Owner),
        "precondition: a current member who created the project is its Owner"
    );

    fx.remove_bob().await;

    // DENY: the creator branch no longer fires without membership.
    assert_eq!(
        projects.effective_permission(fx.p, fx.bob).await.unwrap(),
        None,
        "H-1: a REMOVED member must not keep Owner on a project they created (⇒404)"
    );
    // NOTE, honestly: `list_visible`'s WHERE was ALREADY `membership ∪ accepted
    // share` before this branch, so these two lines held pre-fix as well. They are
    // here to pin that the list and the gate now AGREE (pre-fix they did not: the
    // project was absent from the list yet fully Owner-accessible by id), not as
    // evidence of the fix. TEST-27 covers the label arm this branch actually changed.
    let (bob_list, bob_total) = projects.list_visible(fx.bob, None, 1, 50).await.unwrap();
    assert!(
        bob_list.iter().all(|x| x.id != fx.p),
        "a removed member's created project must not stay on their list"
    );
    assert_eq!(bob_total, 0, "page and total agree for the removed member");

    // POSITIVE CONTROL 1 — alice, a still-current account owner, is unaffected and
    // the project still EXISTS (the deny is a revocation, not a deletion).
    assert_eq!(
        projects.effective_permission(fx.p, fx.alice).await.unwrap(),
        Some(EffectivePermission::Owner),
        "positive control: the account owner still reaches the project"
    );
    let (alice_list, _) = projects.list_visible(fx.alice, None, 1, 50).await.unwrap();
    let row = alice_list
        .iter()
        .find(|x| x.id == fx.p)
        .expect("positive control: P is still listed for a current member");
    assert_eq!(
        row.effective_permission, "owner",
        "positive control: the account owner's label is unchanged"
    );

    // POSITIVE CONTROL 2 — dana, a bare `member` who CREATED Q, keeps Owner on Q.
    // This is the regression a careless fix produces: her authority comes from the
    // creator branch, not from her role's Viewer floor.
    assert_eq!(
        projects.effective_permission(fx.q, fx.dana).await.unwrap(),
        Some(EffectivePermission::Owner),
        "positive control: a CURRENT bare member who created a project keeps Owner"
    );
    // And her own project's label is still `owner`, so ITEM-2's CASE arm did not
    // over-tighten.
    let (dana_list, _) = projects.list_visible(fx.dana, None, 1, 50).await.unwrap();
    assert_eq!(
        dana_list
            .iter()
            .find(|x| x.id == fx.q)
            .expect("dana still lists Q")
            .effective_permission,
        "owner",
    );
}

/// TEST-2 [acceptance] [invariant: INV-11] — `DatasetRepository::is_visible_to`.
#[tokio::test]
async fn removed_member_loses_read_on_the_dataset_they_created() {
    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let datasets = fx.datasets();

    assert!(
        datasets.is_visible_to(fx.d, fx.bob, &[]).await.unwrap(),
        "precondition: a current member reads the dataset they created"
    );

    fx.remove_bob().await;

    assert!(
        !datasets.is_visible_to(fx.d, fx.bob, &[]).await.unwrap(),
        "H-1: a REMOVED member must not keep read on a dataset they created"
    );
    assert!(
        datasets.is_visible_to(fx.d, fx.alice, &[]).await.unwrap(),
        "positive control: the account owner still reads D"
    );
    assert!(
        datasets.is_visible_to(fx.e, fx.dana, &[]).await.unwrap(),
        "positive control: a current bare member still reads the dataset they created"
    );
    assert!(
        datasets.is_visible_to(fx.d, fx.dana, &[]).await.unwrap(),
        "positive control: the account-membership union is untouched — a co-member \
         still reads another member's dataset (DEC-12 unchanged)"
    );
}

/// TEST-3 [acceptance] [invariant: INV-11] — `DatasetRepository::access`, BOTH arms.
///
/// `require_can_edit` must 404 (not 403) for the removed member: a 403 would be an
/// existence oracle, telling an ex-member the dataset is still there.
#[tokio::test]
async fn removed_member_loses_edit_and_visibility_on_their_dataset() {
    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let datasets = fx.datasets();

    assert_eq!(
        datasets.access(fx.d, fx.bob, &[]).await.unwrap(),
        DatasetAccess::CanEdit,
        "precondition: a current member who created the dataset can edit it"
    );

    fx.remove_bob().await;

    assert_eq!(
        datasets.access(fx.d, fx.bob, &[]).await.unwrap(),
        DatasetAccess::NotVisible,
        "H-1: both the visible and can_edit arms collapse for a removed member"
    );
    let err = datasets
        .require_can_edit(fx.d, fx.bob, &[])
        .await
        .expect_err("a removed member cannot edit");
    assert_eq!(
        err.to_api_error().0.as_u16(),
        404,
        "the refusal is 404, not 403 — no existence oracle for an ex-member"
    );

    // POSITIVE CONTROLS.
    assert_eq!(
        datasets.access(fx.d, fx.alice, &[]).await.unwrap(),
        DatasetAccess::CanEdit,
        "positive control: the account owner still edits D"
    );
    assert_eq!(
        datasets.access(fx.e, fx.dana, &[]).await.unwrap(),
        DatasetAccess::CanEdit,
        "positive control: a CURRENT bare member who CREATED the dataset keeps edit \
         — the exact case a delete-the-owner-disjunct fix would have broken"
    );
    assert_eq!(
        datasets.access(fx.d, fx.dana, &[]).await.unwrap(),
        DatasetAccess::ViewOnly,
        "positive control: a bare member is still read-only on someone else's \
         dataset (DEC-12's floor unchanged)"
    );
}

/// TEST-4 [acceptance] [invariant: INV-11] — `editable_subset`, the FOURTH site
/// (not named by the research spike; found by grepping every `owner_id =`).
#[tokio::test]
async fn removed_member_is_absent_from_editable_subset() {
    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let datasets = fx.datasets();
    let all = [fx.d, fx.e];

    assert!(
        datasets
            .editable_subset(&all, fx.bob, &[])
            .await
            .unwrap()
            .contains(&fx.d),
        "precondition: a current member edits the dataset they created"
    );

    fx.remove_bob().await;

    assert_eq!(
        datasets.editable_subset(&all, fx.bob, &[]).await.unwrap(),
        HashSet::new(),
        "H-1 (4th site): a removed member edits nothing in the account"
    );
    let dana_editable = datasets.editable_subset(&all, fx.dana, &[]).await.unwrap();
    assert!(
        dana_editable.contains(&fx.e),
        "positive control: a current bare member still edits the dataset they created"
    );
    assert!(
        !dana_editable.contains(&fx.d),
        "positive control: and still does NOT edit someone else's (floor unchanged)"
    );
    let alice_editable = datasets.editable_subset(&all, fx.alice, &[]).await.unwrap();
    assert!(
        alice_editable.contains(&fx.d) && alice_editable.contains(&fx.e),
        "positive control: the account owner still edits both"
    );
}

/// TEST-5 [acceptance] [invariant: INV-11] — the workstore gates
/// (`require_dataset_read`, `require_artifact_read`, `require_project_read`).
#[tokio::test]
async fn removed_member_loses_the_workstore_gates() {
    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;

    assert!(
        require_dataset_read(&fx.pool, fx.d, fx.bob).await.is_ok(),
        "precondition: a current member passes the dataset gate"
    );

    fx.remove_bob().await;

    assert_eq!(
        require_dataset_read(&fx.pool, fx.d, fx.bob)
            .await
            .unwrap_err()
            .0
            .as_u16(),
        404,
        "H-1: the workstore dataset gate refuses a removed member"
    );
    assert_eq!(
        require_artifact_read(&fx.pool, &fx.artifact, fx.bob)
            .await
            .unwrap_err()
            .0
            .as_u16(),
        404,
        "H-1: and so does the artifact gate that dispatches to it"
    );
    assert_eq!(
        require_project_read(&fx.pool, fx.p, fx.bob)
            .await
            .unwrap_err()
            .0
            .as_u16(),
        404,
        "H-1: and the project gate, via effective_permission"
    );

    // POSITIVE CONTROLS on the same fixture.
    assert!(
        require_dataset_read(&fx.pool, fx.d, fx.alice).await.is_ok(),
        "positive control: the account owner still passes the dataset gate"
    );
    assert!(
        require_artifact_read(&fx.pool, &fx.artifact, fx.alice)
            .await
            .is_ok(),
        "positive control: and the artifact gate"
    );
    assert!(
        require_dataset_read(&fx.pool, fx.e, fx.dana).await.is_ok(),
        "positive control: a current bare member reads their own dataset"
    );
    assert!(
        require_project_read(&fx.pool, fx.q, fx.dana).await.is_ok(),
        "positive control: and their own project"
    );
}

/// TEST-12 (fix/ziee-file-authz) — REGRESSION PIN for the predicate promotion.
/// `file_readable_by` was refactored to delegate to
/// `modules::file::access::readable_file_ids` so the sandbox gate and the
/// `ziee-file` HTTP seam share ONE SQL literal. This test is unmodified and must
/// keep passing: it is the evidence that the promotion was behaviour-preserving.
///
/// TEST-6 [acceptance] [invariant: INV-11] — `sandbox::inputs::file_readable_by`,
/// the FIFTH site (also not named by the spike). This is the gate that decides
/// whether a sandbox may STAGE THE BYTES of a dataset file, so leaving it would
/// have kept the data-plane half of the hole open.
#[tokio::test]
async fn removed_members_sandbox_cannot_stage_the_datasets_bytes() {
    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;

    // NOTE: bob is also the `files.user_id` here, and that branch is deliberately
    // NOT account-gated (DEC-7 — `files` carries no `account_id`). To exercise the
    // DATASET branch in isolation, re-point the file to alice and keep bob's access
    // resting solely on the dataset link.
    sqlx::query("UPDATE files SET user_id = $1 WHERE id = $2")
        .bind(fx.alice)
        .bind(fx.f)
        .execute(&fx.pool)
        .await
        .unwrap();

    assert!(
        file_readable_by(&fx.pool, fx.f, fx.bob).await.unwrap(),
        "precondition: a current member's sandbox may stage a file in the account's dataset"
    );

    fx.remove_bob().await;

    assert!(
        !file_readable_by(&fx.pool, fx.f, fx.bob).await.unwrap(),
        "H-1 (5th site): a REMOVED member's sandbox must not stage the account's bytes"
    );
    assert!(
        file_readable_by(&fx.pool, fx.f, fx.alice).await.unwrap(),
        "positive control: the account owner's sandbox still may"
    );
    assert!(
        file_readable_by(&fx.pool, fx.f, fx.dana).await.unwrap(),
        "positive control: a current bare co-member's sandbox still may"
    );
}

/// TEST-7 [acceptance] [invariant: INV-11] — `list_mine` (page AND total).
#[tokio::test]
async fn removed_member_no_longer_lists_the_datasets_they_created() {
    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let datasets = fx.datasets();

    let (before, before_total) = datasets.list_mine(fx.bob, None, None, 1, 50).await.unwrap();
    assert_eq!(
        (before.len(), before_total),
        (2, 2),
        "precondition: bob lists the two datasets he created (D and D2), page and \
         total agreeing"
    );

    fx.remove_bob().await;

    let (after, after_total) = datasets.list_mine(fx.bob, None, None, 1, 50).await.unwrap();
    assert!(
        after.is_empty() && after_total == 0,
        "H-1: a removed member's listing is empty, and the total agrees with the page"
    );
    let (dana_items, dana_total) = datasets
        .list_mine(fx.dana, None, None, 1, 50)
        .await
        .unwrap();
    assert!(
        dana_items.iter().any(|x| x.id == fx.e) && dana_total == 1,
        "positive control: a current bare member still lists the dataset they created"
    );
}

/// TEST-8 [acceptance] [invariant: INV-11] — `artifact_summary_rows`.
#[tokio::test]
async fn removed_member_gets_no_artifact_summary_for_their_dataset() {
    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let datasets = fx.datasets();

    let before = datasets
        .artifact_summary_rows(fx.bob, &[], 50, 5)
        .await
        .unwrap();
    assert!(
        before.iter().any(|r| r.0 == fx.d),
        "precondition: bob's created dataset appears in his artifact rollup"
    );

    fx.remove_bob().await;

    let after = datasets
        .artifact_summary_rows(fx.bob, &[], 50, 5)
        .await
        .unwrap();
    assert!(
        after.iter().all(|r| r.0 != fx.d),
        "H-1: a removed member's rollup no longer carries the account's dataset"
    );
    // POSITIVE CONTROL — dana, a still-current bare member, still gets the rollup
    // for the dataset SHE created.
    //
    // NOTE the control is dana and not alice: `artifact_summary_rows`'s `visible`
    // CTE is owner ∪ shares with NO account-membership union at all — a
    // PRE-EXISTING narrowness on main, unrelated to this branch, which means an
    // account owner never had a rollup row for another member's dataset. Widening
    // it would be the opposite of this branch's transform, so it is reported, not
    // fixed here.
    let dana_rows = datasets
        .artifact_summary_rows(fx.dana, &[], 50, 5)
        .await
        .unwrap();
    assert!(
        dana_rows.iter().any(|r| r.0 == fx.e),
        "positive control: a CURRENT bare member still gets the rollup for the \
         dataset they created"
    );
}

/// TEST-9 [acceptance] [invariant: INV-11] — `delete`, the DESTRUCTIVE site.
///
/// The repository SQL IS the authority for `DELETE /api/datasets/{id}` (the
/// handler passes `auth.user.id` straight in and maps a 0-row result to 404), so
/// before this fix a removed member could destroy the organization's data.
#[tokio::test]
async fn removed_member_cannot_delete_the_accounts_dataset() {
    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let datasets = fx.datasets();

    fx.remove_bob().await;

    assert!(
        !datasets.delete(fx.d, fx.bob).await.unwrap(),
        "H-1: a removed member must not be able to DELETE the account's dataset"
    );
    let still_there: i64 = sqlx::query_scalar("SELECT count(*) FROM datasets WHERE id = $1")
        .bind(fx.d)
        .fetch_one(&fx.pool)
        .await
        .unwrap();
    assert_eq!(still_there, 1, "and the dataset must still exist");

    // POSITIVE CONTROL: the gate did not simply break deletion — a still-current
    // bare member deletes the dataset they created, exactly as before.
    assert!(
        datasets.delete(fx.e, fx.dana).await.unwrap(),
        "positive control: a CURRENT bare member still deletes their own dataset"
    );
}

/// TEST-10 [acceptance] [invariant: INV-11] — the three `jobs` predicates.
#[tokio::test]
async fn removed_member_loses_jobs_running_on_the_dataset_they_created() {
    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let jobs = fx.jobs();

    let (before, before_total) = jobs
        .list_visible_to(fx.bob, &[], None, 1, 50)
        .await
        .unwrap();
    assert!(
        before.iter().any(|j| j.id == fx.job),
        "precondition: the dataset's creator lists the job running on it"
    );
    assert!(
        before.iter().any(|j| j.id == fx.pjob),
        "precondition: and the job running on the project they created"
    );
    assert_eq!(before_total, 2, "precondition: exactly those two");

    fx.remove_bob().await;

    let (after, after_total) = jobs
        .list_visible_to(fx.bob, &[], None, 1, 50)
        .await
        .unwrap();
    assert!(
        after.iter().all(|j| j.id != fx.job) && after_total == 0,
        "H-1: a removed member no longer lists the account's job (page and total agree)"
    );
    assert_eq!(
        jobs.controllable_subset(&[fx.job], fx.bob, &[]).await.unwrap(),
        HashSet::new(),
        "H-1: and cannot STOP it"
    );
    let (_owner, audience) = JobRepository::visible_to_user_ids(&fx.pool, fx.job)
        .await
        .unwrap()
        .expect("#167: a job whose scope is live has a non-empty audience");
    assert!(
        !audience.contains(&fx.bob),
        "H-1: and stops receiving its live frames"
    );
    // POSITIVE CONTROL for the audience specifically: the set is NOT simply empty —
    // `eve`, D's edit-sharee, is still in it. Without this, "bob is absent" would
    // also hold if the whole CTE had stopped returning anyone.
    assert!(
        audience.contains(&fx.eve),
        "positive control: the audience still reaches D's edit-sharee — the deny \
         above is bob being filtered, not the query returning nobody"
    );

    // The PROJECT arm of the same three predicates, on the project-scoped job.
    assert!(
        after.iter().all(|j| j.id != fx.pjob),
        "H-1 (project arm): the project-scoped job is gone from the removed \
         member's list too"
    );
    assert_eq!(
        jobs.controllable_subset(&[fx.pjob], fx.bob, &[]).await.unwrap(),
        HashSet::new(),
        "H-1 (project arm): and they cannot stop it"
    );
    let (_powner, paudience) = JobRepository::visible_to_user_ids(&fx.pool, fx.pjob)
        .await
        .unwrap()
        .expect("#167: a job whose scope is live has a non-empty audience");
    assert!(
        !paudience.contains(&fx.bob),
        "H-1 (project arm): and stop receiving its frames"
    );

    // POSITIVE CONTROLS on the same fixture: alice is the job's own owner, and dana
    // is a current co-member of the dataset's account.
    let (alice_jobs, alice_total) = jobs
        .list_visible_to(fx.alice, &[], None, 1, 50)
        .await
        .unwrap();
    assert!(
        alice_jobs.iter().any(|j| j.id == fx.job) && alice_total == 4,
        "positive control: the job's owner still lists it (she owns all four in this \
         fixture; page and total agree)"
    );
    assert!(
        jobs.controllable_subset(&[fx.job], fx.alice, &[])
            .await
            .unwrap()
            .contains(&fx.job),
        "positive control: and still controls it"
    );
    // The controls above are WEAK on their own: alice owns every job in this
    // fixture, so `jobs.owner_id = $1` admits her and they would pass with the
    // dataset/project arms deleted outright. The load-bearing controls are dana's —
    // she owns NO job, so her reach over these two can only come from the arms
    // under test.
    let (dana_jobs, _dana_total) = jobs
        .list_visible_to(fx.dana, &[], None, 1, 50)
        .await
        .unwrap();
    assert!(
        dana_jobs.iter().any(|j| j.id == fx.qjob),
        "positive control (PROJECT arm, non-confounded): a current member still lists \
         a job running on the project THEY created, though they do not own the job"
    );
    assert!(
        dana_jobs.iter().any(|j| j.id == fx.ejob),
        "positive control (DATASET arm, non-confounded): …and one running on the \
         dataset they created"
    );
    assert!(
        jobs.controllable_subset(&[fx.qjob, fx.ejob], fx.dana, &[])
            .await
            .unwrap()
            .len()
            == 2,
        "positive control (both arms, non-confounded): and still controls both — the \
         arms were narrowed, not broken"
    );
    let (_qo, qaud) = JobRepository::visible_to_user_ids(&fx.pool, fx.qjob)
        .await
        .unwrap()
        .expect("#167: a job whose scope is live has a non-empty audience");
    assert!(
        qaud.contains(&fx.dana),
        "positive control (audience, project arm, non-confounded): dana is still in \
         the audience of a job on the project she created"
    );
    let (_eo, eaud) = JobRepository::visible_to_user_ids(&fx.pool, fx.ejob)
        .await
        .unwrap()
        .expect("#167: a job whose scope is live has a non-empty audience");
    assert!(
        eaud.contains(&fx.dana),
        "positive control (audience, DATASET arm, non-confounded): …and of one on the \
         dataset she created. Without this the audience query's dataset-owner \
         disjunct could be deleted outright with the suite still green — the bob \
         denies above would pass for the wrong reason"
    );
}

/// TEST-26 [acceptance] [invariant: INV-11] — `split_dataset`'s owner-only gate,
/// the SIXTH site: an inline `if dataset.owner_id != auth.user.id` in the HANDLER
/// rather than a SQL predicate, and destructive (split DELETES the parent and
/// re-owns its files into new datasets).
///
/// It also had to move together with `delete`: with `delete` membership-gated and
/// this gate left on bare creator-ownership, a removed member could still create
/// the split CHILDREN while the parent delete silently no-oped — a half-executed
/// split, which is worse than either the hole or the fix alone.
#[tokio::test]
async fn removed_member_cannot_split_the_accounts_dataset() {
    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let datasets = fx.datasets();

    assert!(
        datasets.is_current_owner(fx.d, fx.bob).await.unwrap(),
        "precondition: a CURRENT member who created the dataset is its lifecycle owner"
    );

    // The split route needs a MULTI-FILE dataset (a single-file one 422s as
    // NOT_SPLITTABLE), so give D a second file — otherwise the 404 below could be
    // produced by the splittability check instead of the gate under test.
    for n in ["b.csv", "c.csv"] {
        let fid = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO files (id, user_id, filename, file_size, current_version_id, created_by) \
             VALUES ($1, $2, $3, 10, $4, 'user')",
        )
        .bind(fid)
        .bind(fx.bob)
        .bind(n)
        .bind(Uuid::new_v4())
        .execute(&fx.pool)
        .await
        .expect("seed file");
        sqlx::query(
            "INSERT INTO dataset_files (dataset_id, file_id, ordinal, role) \
             VALUES ($1, $2, 1, 'primary')",
        )
        .bind(fx.d)
        .bind(fid)
        .execute(&fx.pool)
        .await
        .expect("seed extra files so D is splittable");
    }

    let bob_token = super::login(&server, "bob").await;
    let split = |token: String, ds: Uuid| {
        let client = server.client.clone();
        let url = server.api_url(&format!("/datasets/{ds}/split"));
        async move {
            client
                .post(url)
                .bearer_auth(token)
                .send()
                .await
                .expect("split")
                .status()
                .as_u16()
        }
    };

    fx.remove_bob().await;

    assert!(
        !datasets.is_current_owner(fx.d, fx.bob).await.unwrap(),
        "H-1 (6th site): a REMOVED member is not the lifecycle owner, so split 404s"
    );
    // And the ROUTE itself refuses — the defect lived in the handler's `if`, so the
    // repository predicate alone would not have caught a revert of that line.
    assert_eq!(
        split(bob_token.clone(), fx.d).await,
        404,
        "H-1 (6th site): POST /datasets/{{id}}/split must refuse a removed member"
    );
    let parent_still_there: i64 = sqlx::query_scalar("SELECT count(*) FROM datasets WHERE id = $1")
        .bind(fx.d)
        .fetch_one(&fx.pool)
        .await
        .unwrap();
    assert_eq!(
        parent_still_there, 1,
        "and the parent was NOT deleted — no half-executed split"
    );
    let children: i64 =
        sqlx::query_scalar("SELECT count(*) FROM datasets WHERE account_id = $1 AND name LIKE $2")
            .bind(fx.org)
            .bind(format!("{} — %", "bobs-dataset"))
            .fetch_one(&fx.pool)
            .await
            .unwrap();
    assert_eq!(children, 0, "and no split CHILDREN were written either");
    // POSITIVE CONTROLS: a still-current bare member who created a dataset IS its
    // lifecycle owner, and a co-member who did NOT create it is not (the gate still
    // GRADES — it did not simply refuse everyone).
    assert!(
        datasets.is_current_owner(fx.e, fx.dana).await.unwrap(),
        "positive control: a CURRENT bare member still owns the lifecycle of the \
         dataset they created"
    );
    assert!(
        !datasets.is_current_owner(fx.d, fx.alice).await.unwrap(),
        "positive control: the gate still grades — an account owner who did not \
         CREATE the dataset is not its lifecycle owner (unchanged by this branch)"
    );

    // And the predicate agrees with `delete`, which it is a copy of — the pairing
    // that prevents the half-executed split.
    assert!(
        !datasets.delete(fx.d, fx.bob).await.unwrap(),
        "lifecycle-owner and delete must agree for the removed member"
    );
    assert!(
        datasets.delete(fx.e, fx.dana).await.unwrap(),
        "and for the current creator-member"
    );
}

/// TEST-32 — the split ROUTE's positive control, split out so TEST-26's deny and
/// this allow do not have to share a fixture whose parent the allow would consume.
///
/// A still-current bare member SPLITS the multi-file dataset they created: 200, the
/// parent is gone and the children exist. Without this, TEST-26's 404 would also be
/// produced by a route that refuses everyone.
#[tokio::test]
async fn a_current_member_can_still_split_the_dataset_they_created() {
    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let dana_token = super::login(&server, "dana").await;

    for n in ["e1.csv", "e2.csv"] {
        let fid = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO files (id, user_id, filename, file_size, current_version_id, created_by) \
             VALUES ($1, $2, $3, 10, $4, 'user')",
        )
        .bind(fid)
        .bind(fx.dana)
        .bind(n)
        .bind(Uuid::new_v4())
        .execute(&fx.pool)
        .await
        .expect("seed file");
        sqlx::query(
            "INSERT INTO dataset_files (dataset_id, file_id, ordinal, role) \
             VALUES ($1, $2, 1, 'primary')",
        )
        .bind(fx.e)
        .bind(fid)
        .execute(&fx.pool)
        .await
        .expect("seed files on E");
    }

    let status = server
        .client
        .post(server.api_url(&format!("/datasets/{}/split", fx.e)))
        .bearer_auth(&dana_token)
        .send()
        .await
        .expect("split")
        .status()
        .as_u16();
    assert!(
        (200..300).contains(&status),
        "positive control: a CURRENT bare member still splits the dataset they \
         created (got {status}) — so TEST-26's 404 is the membership gate, not a \
         route that refuses everyone"
    );
    let parent: i64 = sqlx::query_scalar("SELECT count(*) FROM datasets WHERE id = $1")
        .bind(fx.e)
        .fetch_one(&fx.pool)
        .await
        .unwrap();
    assert_eq!(
        parent, 0,
        "positive control: and the parent really was consumed"
    );
}

/// TEST-27 [acceptance] [invariant: INV-11] — the `list_visible` LABEL arm.
///
/// The one row shape ITEM-2 changes is a removed ex-owner who is STILL reachable
/// through an accepted share: pre-fix the list labelled them `owner` while
/// `effective_permission` (post-ITEM-1) reports the share level. Nothing else in
/// the suite constructs that state, so without this test the CASE-arm hunk could
/// be reverted with everything still green.
///
/// The state is built by direct INSERT: the shipped API does not currently produce
/// it (a transfer re-points `owner_id` and deletes the new owner's self-share), so
/// this pins the two predicates AGREEING in a state the schema permits rather than
/// one a route emits today. That is the point — a label and a gate that disagree
/// is a defect whether or not a route happens to reach it.
#[tokio::test]
async fn a_removed_ex_owner_with_a_share_is_labelled_by_the_share_not_owner() {
    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let projects = fx.projects();

    // bob owns P and also holds an ACCEPTED viewer share on it.
    sqlx::query(
        "INSERT INTO project_shares (id, project_id, owner_id, recipient_id, permission_level, status) \
         VALUES (randomblob(16), $1, $2, $3, 'viewer', 'accepted')",
    )
    .bind(fx.p)
    .bind(fx.alice)
    .bind(fx.bob)
    .execute(&fx.pool)
    .await
    .expect("seed an accepted share to bob on his own project");

    fx.remove_bob().await;

    // The share keeps the row VISIBLE (the orthogonal union is preserved) …
    let (list, _total) = projects.list_visible(fx.bob, None, 1, 50).await.unwrap();
    let row = list
        .iter()
        .find(|x| x.id == fx.p)
        .expect("positive control: the accepted-share union still lists the project");

    // … and the gate grades him at the SHARE level, not Owner.
    let perm = projects.effective_permission(fx.p, fx.bob).await.unwrap();
    assert_eq!(
        perm,
        Some(EffectivePermission::Viewer),
        "H-1: a removed ex-owner is graded by their surviving share, not by having \
         created the project"
    );
    // The LABEL must say the same thing — this is the ITEM-2 arm.
    assert_eq!(
        row.effective_permission, "viewer",
        "the list label must agree with the gate: `owner` here would tell the UI to \
         offer delete/transfer/share on a project the API will refuse"
    );
}

/// TEST-28 [acceptance] [invariant: INV-11] — the REAL platform-admin removal path,
/// end to end over HTTP.
///
/// Every other H-1 test removes membership with a raw `DELETE FROM
/// account_members`, which proves the predicates but not that the shipped route
/// reaches them. #147 asks for the matrix to be repeated for the platform-admin
/// removal path specifically, and asks for the HTTP answers (`GET
/// /api/projects/P ⇒ 404`, `GET /api/datasets/D ⇒ 404`) rather than a repository
/// return value — the handler's mapping of a newly-`None` permission is its own
/// step and is otherwise unpinned.
#[tokio::test]
async fn the_admin_removal_route_revokes_over_http() {
    use crate::admin::admin_remove_member;

    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let bob_token = super::login(&server, "bob").await;
    let dana_token = super::login(&server, "dana").await;

    let get = |token: String, path: String| {
        let client = server.client.clone();
        let url = server.api_url(&path);
        async move {
            client
                .get(url)
                .bearer_auth(token)
                .send()
                .await
                .expect("get")
                .status()
                .as_u16()
        }
    };

    // BEFORE: bob reads both resources he created.
    assert_eq!(
        get(bob_token.clone(), format!("/projects/{}", fx.p)).await,
        200,
        "precondition: a current member reads the project they created"
    );
    assert_eq!(
        get(bob_token.clone(), format!("/datasets/{}", fx.d)).await,
        200,
        "precondition: and the dataset"
    );

    // The REAL route, driven as a platform admin.
    let status =
        admin_remove_member(&server, Some(&fx.admin_token), &fx.org.to_string(), fx.bob).await;
    assert!(
        (200..300).contains(&status),
        "the admin removal route must succeed on an ORG member (got {status})"
    );

    // AFTER: 404 — not 403. The path parameter is an id an ex-member already knows,
    // but the codebase's rule for a resource in an account you are not a member of
    // is invisibility, and a 403 here would confirm the resource still exists.
    assert_eq!(
        get(bob_token.clone(), format!("/projects/{}", fx.p)).await,
        404,
        "INV-11 over HTTP: the project they created is now invisible"
    );
    assert_eq!(
        get(bob_token.clone(), format!("/datasets/{}", fx.d)).await,
        404,
        "INV-11 over HTTP: and so is the dataset"
    );

    // POSITIVE CONTROLS on the same server, after the same removal: the resources
    // still EXIST and a still-current member still reads them, and dana still reads
    // what she created. Without these, the 404s above would also be produced by a
    // broken route, an expired token, or a deleted resource.
    let alice_token = super::login(&server, "alice").await;
    assert_eq!(
        get(alice_token.clone(), format!("/projects/{}", fx.p)).await,
        200,
        "positive control: the account owner still reads the project"
    );
    assert_eq!(
        get(alice_token, format!("/datasets/{}", fx.d)).await,
        200,
        "positive control: and the dataset — it was revoked, not deleted"
    );
    assert_eq!(
        get(dana_token.clone(), format!("/projects/{}", fx.q)).await,
        200,
        "positive control: a current bare member still reads what they created"
    );

    // #140's INV-D1 discrimination, at the HTTP layer: a bare member SEES a project
    // they neither created nor were shared (200) but may not EDIT it (403, not 404
    // — they can already see it, so there is no existence left to protect). Pinned
    // here so this branch cannot be blamed for a later change to that split.
    assert_eq!(
        get(dana_token.clone(), format!("/projects/{}", fx.p)).await,
        200,
        "INV-D1: a bare account member can SEE another member's project"
    );
    let patch = server
        .client
        .post(server.api_url(&format!("/projects/{}", fx.p)))
        .bearer_auth(&dana_token)
        .json(&serde_json::json!({ "name": "renamed" }))
        .send()
        .await
        .expect("patch project")
        .status()
        .as_u16();
    assert_eq!(
        patch, 403,
        "INV-D1: …but may not EDIT it — 403 (visible, not permitted), never 404"
    );
}

/// TEST-29 [acceptance] [invariant: INV-11] — the dataset SHARE routes, and the
/// escalation they enabled.
///
/// `share_dataset`, `unshare_dataset` and `list_shares` each gated on a bare
/// `repo.owner_of(id) != Some(auth.user.id)`. The share route was a COMPLETE
/// BYPASS of this whole branch: every hardened predicate deliberately preserves
/// its `dataset_shares` disjunct, so a removed member could grant THEMSELVES an
/// `edit` share on the org's dataset and walk straight back in — permanently,
/// with no membership. This test drives the real HTTP routes, because the defect
/// lived in the handler and not in any SQL predicate.
#[tokio::test]
async fn a_removed_member_cannot_reshare_their_way_back_into_the_account() {
    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let bob_token = super::login(&server, "bob").await;
    let datasets = fx.datasets();

    // Precondition: as a CURRENT member and creator, bob may manage D's shares.
    let before = server
        .client
        .get(server.api_url(&format!("/datasets/{}/shares", fx.d)))
        .bearer_auth(&bob_token)
        .send()
        .await
        .expect("list shares")
        .status()
        .as_u16();
    assert_eq!(
        before, 200,
        "precondition: the creator-member lists D's shares"
    );

    fx.remove_bob().await;

    // DENY — the escalation attempt: bob tries to grant HIMSELF an edit share.
    let share = server
        .client
        .post(server.api_url(&format!("/datasets/{}/shares", fx.d)))
        .bearer_auth(&bob_token)
        .json(&serde_json::json!({
            "principal_type": "user", "principal_id": fx.bob, "role": "edit"
        }))
        .send()
        .await
        .expect("share attempt")
        .status()
        .as_u16();
    assert_eq!(
        share, 404,
        "H-1: a removed member must not be able to share the account's dataset — \
         self-sharing an edit role would restore full access permanently"
    );
    // …and the escalation did not happen behind the status code.
    assert_eq!(
        datasets.access(fx.d, fx.bob, &[]).await.unwrap(),
        DatasetAccess::NotVisible,
        "H-1: no share was written, so the removed member is still locked out"
    );

    // DENY — reading the ACL, and revoking the remaining members' access.
    assert_eq!(
        server
            .client
            .get(server.api_url(&format!("/datasets/{}/shares", fx.d)))
            .bearer_auth(&bob_token)
            .send()
            .await
            .expect("list shares")
            .status()
            .as_u16(),
        404,
        "H-1: and must not be able to read the account dataset's ACL"
    );

    // DENY — the PRE-REMOVAL half of the same escalation, which the post-removal
    // gate alone does not close: a member could grant themselves an `edit` share one
    // second BEFORE being removed and reach the identical end state, because every
    // hardened predicate preserves the share union by design. Asserted here on the
    // still-current member, since that is when the attempt would be made.
    let dana_token = super::login(&server, "dana").await;
    let self_share_resp = server
        .client
        .post(server.api_url(&format!("/datasets/{}/shares", fx.e)))
        .bearer_auth(&dana_token)
        .json(&serde_json::json!({
            "principal_type": "user", "principal_id": fx.dana, "role": "edit"
        }))
        .send()
        .await
        .expect("self-share attempt");
    let self_share = self_share_resp.status().as_u16();
    let self_share_body: serde_json::Value = self_share_resp
        .json()
        .await
        .unwrap_or(serde_json::Value::Null);
    assert_eq!(
        self_share, 400,
        "TEST-36 / H-1: a member may not grant THEMSELVES a share on the dataset \
         they own — that share would outlive their membership and restore full \
         access"
    );
    // Bind to the CODE, not just the status: the route 400s on an invalid
    // principal_type and on an invalid role too, so a status-only assertion would
    // pass if this request were rejected for an unrelated reason.
    assert!(
        format!("{self_share_body}").contains("SELF_SHARE"),
        "TEST-36: refused BY NAME (`SELF_SHARE`), not by some other 400 — got \
         {self_share_body}"
    );

    // DENY — revoking a share, the leg that lets a removed member cut the REMAINING
    // members off. `eve`'s edit share on D is the fixture's real share row.
    let eve_share: Uuid =
        sqlx::query_scalar("SELECT id FROM dataset_shares WHERE dataset_id = $1 LIMIT 1")
            .bind(fx.d)
            .fetch_one(&fx.pool)
            .await
            .expect("D has eve's edit share");
    assert_eq!(
        server
            .client
            .delete(server.api_url(&format!("/datasets/{}/shares/{}", fx.d, eve_share)))
            .bearer_auth(&bob_token)
            .send()
            .await
            .expect("unshare")
            .status()
            .as_u16(),
        404,
        "H-1: and must not be able to REVOKE the remaining members' access"
    );
    let survived: i64 = sqlx::query_scalar("SELECT count(*) FROM dataset_shares WHERE id = $1")
        .bind(eve_share)
        .fetch_one(&fx.pool)
        .await
        .unwrap();
    assert_eq!(survived, 1, "and the share really is still there");

    // POSITIVE CONTROL — dana, a still-current bare member, manages the shares of
    // the dataset SHE created, over the same routes on the same server.
    assert_eq!(
        server
            .client
            .get(server.api_url(&format!("/datasets/{}/shares", fx.e)))
            .bearer_auth(&dana_token)
            .send()
            .await
            .expect("list shares")
            .status()
            .as_u16(),
        200,
        "positive control: a CURRENT bare member still lists their own dataset's ACL"
    );
    let ok_resp = server
        .client
        .post(server.api_url(&format!("/datasets/{}/shares", fx.e)))
        .bearer_auth(&dana_token)
        .json(&serde_json::json!({
            "principal_type": "user", "principal_id": fx.alice, "role": "view"
        }))
        .send()
        .await
        .expect("share");
    let ok = ok_resp.status().as_u16();
    let ok_body: serde_json::Value = ok_resp.json().await.unwrap_or(serde_json::Value::Null);
    assert_eq!(
        ok, 201,
        "positive control: and still shares it — the gate was narrowed, not broken"
    );
    // …and still UNSHARES it, so the unshare deny above is the gate and not a
    // route that refuses everyone.
    let danas_share = ok_body["id"].as_str().expect("share id").to_string();
    assert_eq!(
        server
            .client
            .delete(server.api_url(&format!("/datasets/{}/shares/{}", fx.e, danas_share)))
            .bearer_auth(&dana_token)
            .send()
            .await
            .expect("unshare")
            .status()
            .as_u16(),
        204,
        "positive control: a CURRENT bare member still revokes a share on their own \
         dataset"
    );
}

/// TEST-30 [acceptance] [invariant: INV-11] — dataset FOLDER listing + membership.
///
/// `list_datasets_in_folder`'s predicate constrained only the FOLDER's owner —
/// nothing constrained the dataset — so a removed member kept reading the full
/// rows (name, `account_id`, datatype, metadata, `content_hash`) of every org
/// dataset they had foldered. Its sibling `list_mine` WAS conjoined, so the two
/// had to move together or the folder view would contradict the gate.
#[tokio::test]
async fn removed_member_cannot_read_the_accounts_datasets_through_a_folder() {
    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let datasets = fx.datasets();

    // bob folders D; dana folders E. Both are legitimate today.
    let bob_folder = datasets.create_folder(fx.bob, "bobs").await.unwrap().id;
    assert!(
        datasets
            .add_to_folder(bob_folder, fx.d, fx.bob)
            .await
            .unwrap(),
        "precondition: a current member can folder the dataset they created"
    );
    let dana_folder = datasets.create_folder(fx.dana, "danas").await.unwrap().id;
    assert!(datasets
        .add_to_folder(dana_folder, fx.e, fx.dana)
        .await
        .unwrap());

    assert_eq!(
        datasets
            .list_datasets_in_folder(bob_folder, fx.bob, 1, 50)
            .await
            .unwrap()
            .len(),
        1,
        "precondition: and read it back through the folder"
    );

    fx.remove_bob().await;

    assert!(
        datasets
            .list_datasets_in_folder(bob_folder, fx.bob, 1, 50)
            .await
            .unwrap()
            .is_empty(),
        "H-1: the folder view must not keep serving the account's dataset rows to a \
         removed member"
    );
    assert!(
        !datasets
            .add_to_folder(bob_folder, fx.d2, fx.bob)
            .await
            .unwrap(),
        "H-1: nor may they keep re-foldering the account's datasets — the INSERT \
         guard path, asserted on a dataset NOT already in the folder"
    );
    // …and the FALLBACK path, which is a separate predicate: when the INSERT guard
    // matches nothing, `add_to_folder` re-checks membership-in-the-folder and
    // returns true for a dataset that is ALREADY there. D *is* already in
    // `bob_folder`, so this is the only assertion that exercises the conjuncts on
    // that re-check — without it the fallback could be reverted with the tree green,
    // and a removed member would get a false `Ok(true)` contradicting
    // `list_datasets_in_folder`, which no longer returns that row.
    assert!(
        !datasets
            .add_to_folder(bob_folder, fx.d, fx.bob)
            .await
            .unwrap(),
        "H-1: and the 'already a member' fallback must refuse them too — a false \
         success here would contradict the (now empty) folder listing above"
    );

    // POSITIVE CONTROL — dana's folder still works, on the same fixture.
    assert_eq!(
        datasets
            .list_datasets_in_folder(dana_folder, fx.dana, 1, 50)
            .await
            .unwrap()
            .len(),
        1,
        "positive control: a CURRENT bare member still reads their folder"
    );
    assert!(
        datasets
            .add_to_folder(dana_folder, fx.e, fx.dana)
            .await
            .unwrap(),
        "positive control: and still folders their own dataset — E is ALREADY in \
         dana's folder, so this exercises the same FALLBACK predicate as the deny \
         above and proves it still says yes for a current creator-member"
    );
}

/// TEST-31 [acceptance] [invariant: INV-11] — `ProjectRepository::revoke_share`.
///
/// One of the project mutations that does not funnel through
/// `ProjectScope::resolve` → `effective_permission` (the handler calls it
/// directly), so it never inherited that fix. A removed member otherwise kept
/// authority over the account's project ACL — able to revoke the REMAINING
/// members' shares on a project they can no longer even open.
///
/// (An earlier revision of this comment said "the ONE such mutation" — that was
/// false. `cancel_transfer` is the sibling it hid; it was gated and then
/// deliberately un-gated, see DEC-16 and its own doc comment.)
#[tokio::test]
async fn removed_member_cannot_revoke_shares_on_the_accounts_project() {
    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let projects = fx.projects();

    // bob (P's creator) shares P with alice; dana (Q's creator) shares Q with alice.
    let bob_share = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO project_shares (id, project_id, owner_id, recipient_id, \
         permission_level, status) VALUES ($1, $2, $3, $4, 'viewer', 'accepted')",
    )
    .bind(bob_share)
    .bind(fx.p)
    .bind(fx.bob)
    .bind(fx.alice)
    .execute(&fx.pool)
    .await
    .expect("bob shares P with alice");

    let dana_share = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO project_shares (id, project_id, owner_id, recipient_id, \
         permission_level, status) VALUES ($1, $2, $3, $4, 'viewer', 'accepted')",
    )
    .bind(dana_share)
    .bind(fx.q)
    .bind(fx.dana)
    .bind(fx.alice)
    .execute(&fx.pool)
    .await
    .expect("dana shares Q with alice");

    fx.remove_bob().await;

    assert!(
        !projects.revoke_share(bob_share, fx.bob).await.unwrap(),
        "H-1: a removed member must not keep revoke authority over the account's \
         project ACL"
    );
    let still: i64 = sqlx::query_scalar("SELECT count(*) FROM project_shares WHERE id = $1")
        .bind(bob_share)
        .fetch_one(&fx.pool)
        .await
        .unwrap();
    assert_eq!(still, 1, "and the share really is still there");

    // POSITIVE CONTROL — dana, a still-current bare member, revokes the share SHE
    // granted, so the gate was narrowed rather than broken.
    assert!(
        projects.revoke_share(dana_share, fx.dana).await.unwrap(),
        "positive control: a CURRENT bare member still revokes their own share"
    );
}

/// TEST-33 [acceptance] [invariant: INV-11] — the STOP gate, on the one principal
/// that reaches it: a removed member whose EDIT SHARE on the dataset survives.
///
/// `resolve_job_reach`'s dataset arm graded Control-vs-See with a bare
/// `owner_of(dataset_id) == Some(user)`. That looks safe — `access()` is
/// membership-gated upstream — but `access()` returns `CanEdit` through THREE
/// disjuncts, and the `dataset_shares role='edit'` union is deliberately preserved
/// by this whole branch. So a removed member holding a surviving edit share on the
/// dataset THEY created still reached `CanEdit`, and the bare owner comparison then
/// handed them **Control** — which `jobs/routes.rs` uses as the stop gate. They
/// could kill the account's running jobs.
///
/// This is the ONLY shape that reaches the line, which is why no other test in the
/// suite covers it: every other removed-member fixture has no share, so `access()`
/// answers `NotVisible` and the arm is never entered.
#[tokio::test]
async fn a_removed_member_with_a_surviving_edit_share_may_watch_but_not_stop() {
    use cytoanalyst::modules::jobs::authz::{resolve_job_reach, JobReach};
    use cytoanalyst::modules::jobs::models::Job;

    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;

    // A share bob holds on the dataset he created, granted while he was still a
    // member (he can no longer grant one himself — TEST-29 — but an existing row,
    // or a group share, survives the removal by design: the share union is
    // orthogonal to membership and this branch does not narrow it).
    sqlx::query(
        "INSERT INTO dataset_shares (id, dataset_id, principal_type, principal_id, role) \
         VALUES (randomblob(16), $1, 'user', $2, 'edit')",
    )
    .bind(fx.d)
    .bind(fx.bob)
    .execute(&fx.pool)
    .await
    .expect("seed bob's edit share on D");

    let job_of = |id: Uuid| {
        let pool = fx.pool.clone();
        async move {
            sqlx::query_as::<_, Job>("SELECT * FROM jobs WHERE id = $1")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap()
        }
    };

    // PRECONDITION: as a current creator-member, bob CONTROLS the job on D.
    let j = job_of(fx.job).await;
    assert_eq!(
        resolve_job_reach(&fx.pool, &j, fx.bob, false, &[])
            .await
            .unwrap(),
        JobReach::Control,
        "precondition: the dataset's creator-member controls jobs running on it"
    );

    fx.remove_bob().await;

    // The share keeps him at CanEdit — so he is still admitted to the arm at all,
    // which is what makes this test reach the line rather than short-circuit.
    assert_eq!(
        fx.datasets().access(fx.d, fx.bob, &[]).await.unwrap(),
        DatasetAccess::CanEdit,
        "the surviving edit share still confers CanEdit — the branch deliberately \
         does not narrow the share union, and that is exactly why the STOP grader \
         cannot rely on membership having been checked upstream"
    );

    // DENY: he may WATCH, but may not STOP.
    let reach = resolve_job_reach(&fx.pool, &j, fx.bob, false, &[])
        .await
        .unwrap();
    assert_eq!(
        reach,
        JobReach::See,
        "H-1: a REMOVED member must not keep STOP authority over the account's \
         running jobs, however they retained visibility"
    );
    assert!(reach.can_see(), "…and the share still lets them watch");
    assert!(!reach.can_control(), "…but not end the run");

    // The SQL mirror must agree — a grader split here is how a UI offers a Stop
    // button the API refuses, or vice versa.
    assert!(
        !fx.jobs()
            .controllable_subset(&[fx.job], fx.bob, &[])
            .await
            .unwrap()
            .contains(&fx.job),
        "H-1: and `controllable_subset` agrees on the same principal"
    );

    // POSITIVE CONTROL — a still-current bare member who created a dataset keeps
    // Control over jobs running on it, so the gate was narrowed and not broken.
    let ej = job_of(fx.ejob).await;
    assert_eq!(
        resolve_job_reach(&fx.pool, &ej, fx.dana, false, &[])
            .await
            .unwrap(),
        JobReach::Control,
        "positive control: a CURRENT bare member still controls jobs on the dataset \
         they created (and owns no job, so this is not the creator short-circuit)"
    );
    assert!(
        fx.jobs()
            .controllable_subset(&[fx.ejob], fx.dana, &[])
            .await
            .unwrap()
            .contains(&fx.ejob),
        "positive control: and the SQL mirror agrees"
    );
}

/// TEST-34 [acceptance] [invariant: INV-11b] — `is_current_owner` ⇔ `delete`.
///
/// The two are hand-copied SQL literals with the same meaning: `is_current_owner`
/// gates share / unshare / list-shares / split, while `delete` carries its own
/// inline `WHERE` because it must gate and delete in one statement. That is the
/// same drift risk this module already answers for `editable_subset` ↔ `access`,
/// and it was originally "answered" here by a COMMENT asserting the two could not
/// drift — an unbacked claim of exactly the kind this branch had to correct
/// elsewhere. This is the test that makes it true.
#[tokio::test]
async fn is_current_owner_matches_delete() {
    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let datasets = fx.datasets();

    // Grade every principal × both predicates, BEFORE and AFTER the removal. `delete`
    // is destructive, so it is probed on a throwaway clone of each dataset rather
    // than on the fixture's own rows.
    let clone_of = |src: Uuid, owner: Uuid| {
        let pool = fx.pool.clone();
        async move {
            let id = Uuid::new_v4();
            sqlx::query(
                "INSERT INTO datasets (id, name, owner_id, account_id, datatype, metadata) \
                 SELECT $1, name || '-clone', $3, account_id, datatype, metadata \
                   FROM datasets WHERE id = $2",
            )
            .bind(id)
            .bind(src)
            .bind(owner)
            .execute(&pool)
            .await
            .expect("clone dataset");
            id
        }
    };

    let mut any_yes = false;
    let mut any_no = false;
    for (label, subject_owner, who) in [
        ("creator+member (bob, before)", fx.bob, fx.bob),
        ("account owner, not creator", fx.bob, fx.alice),
        ("bare member, not creator", fx.bob, fx.dana),
        ("bare member who created it", fx.dana, fx.dana),
        // NOTE the label: eve is a non-member who is also not the creator. Her
        // edit share is on `fx.d`, and each row here is graded on a fresh CLONE
        // that carries no `dataset_shares` rows — so this row exercises
        // "non-member, non-creator" and touches the share axis zero times.
        // Harmless (neither predicate consults shares) but worth saying, since
        // mislabelled coverage is the exact hazard this branch keeps tripping on.
        ("non-member, non-creator (eve)", fx.bob, fx.eve),
    ] {
        let c = clone_of(fx.d, subject_owner).await;
        let by_gate = datasets.is_current_owner(c, who).await.unwrap();
        let by_delete = datasets.delete(c, who).await.unwrap();
        assert_eq!(
            by_gate, by_delete,
            "{label}: is_current_owner says {by_gate}, delete says {by_delete} — the \
             two literals have drifted"
        );
        any_yes |= by_gate;
        any_no |= !by_gate;
    }
    // Negative controls: agreement is trivial if both answer the same for everyone.
    assert!(any_yes, "some principal was the current owner");
    assert!(any_no, "some principal was not");

    // And after the removal, on the condition this branch is about.
    fx.remove_bob().await;
    let c = clone_of(fx.d, fx.bob).await;
    let by_gate = datasets.is_current_owner(c, fx.bob).await.unwrap();
    let by_delete = datasets.delete(c, fx.bob).await.unwrap();
    assert_eq!(
        by_gate, by_delete,
        "removed creator: the two must still agree"
    );
    assert!(!by_gate, "…and the agreed answer is NO");
}

/// TEST-35 — `cancel_transfer` is deliberately NOT membership-gated, and this test
/// exists to keep it that way.
///
/// An earlier round of this branch applied the same transform here as everywhere
/// else. A blind audit then showed it was the branch's one genuine over-tightening:
/// it closed no reachable attack and stranded the project's transfer capability
/// inside the tenant. It was reverted (DEC-16), and this test replaces the deny it
/// used to assert — because a reverted line is otherwise invisible, and the next
/// person sweeping for `owner_id`-shaped predicates will find this one and "fix" it.
///
/// The two facts that make the revert safe are asserted, not narrated:
///
/// 1. the cancel is RELEASE-ONLY and still works for the removed initiator, so the
///    account is not stranded with an unclearable pending row; and
/// 2. it is NOT DURABLE — the same user cannot re-create a transfer afterwards,
///    because `create_transfer` runs through the membership-gated
///    `effective_permission`. That is what makes the retained capability harmless.
///
/// If someone re-applies the membership conjunct to `cancel_transfer`, assertion 1
/// goes red and points here.
#[tokio::test]
async fn cancel_transfer_stays_open_to_a_removed_initiator_but_buys_them_nothing() {
    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let projects = fx.projects();

    let transfer = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO project_transfers (id, project_id, from_user_id, to_user_id, status) \
         VALUES ($1, $2, $3, $4, 'pending')",
    )
    .bind(transfer)
    .bind(fx.p)
    .bind(fx.bob)
    .bind(fx.eve)
    .execute(&fx.pool)
    .await
    .expect("seed pending transfer");

    fx.remove_bob().await;

    // (1) RELEASE-ONLY, and still permitted. Gating this is what stranded the row:
    // there is no owner/admin cancel path, so with the initiator refused the only
    // remaining exits are destructive or platform-admin-only.
    //
    // #171 CORRECTION — this comment used to open with "`remove_member` does not
    // cascade to `project_transfers` and…". That clause is now FALSE: #171 made
    // `remove_member` cancel the departing member's pending transfers in both
    // directions, inside the removal transaction. It is corrected rather than deleted
    // because a false rationale in the test that PROTECTS a revert is the most
    // dangerous place for one — the next person sweeping this area reads exactly this
    // comment. The revert it protects is UNAFFECTED: the un-gated `cancel_transfer`
    // still matters for every state removal does not clear (a DEMOTED initiator's
    // row, above all — see `cancel_transfer`'s own doc), and this test still reaches
    // it because `remove_bob` deletes the membership by RAW SQL and so never runs the
    // #171 hook. See `src-app/server/tests/account/transfer_escape_test.rs`.
    assert!(
        projects.cancel_transfer(transfer, fx.bob).await.unwrap(),
        "DEC-16: the removed initiator may still CANCEL — the only state they can \
         touch is a row they created, and the only direction is the one that \
         UNBLOCKS the account. Gating this closed no attack and stranded the \
         project's transfer capability"
    );
    let gone: i64 = sqlx::query_scalar("SELECT count(*) FROM project_transfers WHERE id = $1")
        .bind(transfer)
        .fetch_one(&fx.pool)
        .await
        .unwrap();
    assert_eq!(gone, 0, "and the blocking row really is released");

    // (2) NOT DURABLE — the retained capability buys them nothing, because they
    // cannot create a new transfer: `create_transfer` resolves through
    // `effective_permission`, whose owner branch this branch made membership-gated.
    assert_eq!(
        projects.effective_permission(fx.p, fx.bob).await.unwrap(),
        None,
        "DEC-16: …and it is harmless, because the same user can no longer reach the \
         project at all, so no new transfer can be initiated"
    );

    // POSITIVE CONTROL — a still-current member's cancel behaves identically, so
    // assertion (1) is not passing because the function accepts everyone.
    let danas = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO project_transfers (id, project_id, from_user_id, to_user_id, status) \
         VALUES ($1, $2, $3, $4, 'pending')",
    )
    .bind(danas)
    .bind(fx.q)
    .bind(fx.dana)
    .bind(fx.eve)
    .execute(&fx.pool)
    .await
    .expect("seed dana's pending transfer");
    assert!(
        projects.cancel_transfer(danas, fx.dana).await.unwrap(),
        "positive control: a CURRENT member still cancels their own pending transfer"
    );
    // …and the function does still GRADE: a third party cannot cancel it.
    let other = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO project_transfers (id, project_id, from_user_id, to_user_id, status) \
         VALUES ($1, $2, $3, $4, 'pending')",
    )
    .bind(other)
    .bind(fx.q)
    .bind(fx.dana)
    .bind(fx.eve)
    .execute(&fx.pool)
    .await
    .expect("re-seed");
    assert!(
        !projects.cancel_transfer(other, fx.alice).await.unwrap(),
        "negative control: someone who did not initiate it still cannot cancel — \
         the from_user_id scoping is intact"
    );
}

// ============================ INV-11b lock-step ============================

/// TEST-11 [acceptance] [invariant: INV-11b] — `require_dataset_read` ⇔
/// `is_visible_to` on exactly the removed-owner condition.
///
/// `workstore/authz.rs` documents a `require_dataset_read_matches_is_visible_to`
/// integration test holding these two SQL literals in lock-step; no such test
/// existed in the tree (only the doc comment referencing it). #147 asks for the
/// pair to be asserted on the removed-owner case, so this creates it.
#[tokio::test]
async fn require_dataset_read_matches_is_visible_to_for_a_removed_owner() {
    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let datasets = fx.datasets();

    for (who, label) in [(fx.bob, "creator+member"), (fx.dana, "co-member")] {
        assert_eq!(
            datasets.is_visible_to(fx.d, who, &[]).await.unwrap(),
            require_dataset_read(&fx.pool, fx.d, who).await.is_ok(),
            "before removal, the two predicates must agree for {label}"
        );
    }

    fx.remove_bob().await;

    for (who, label) in [
        (fx.bob, "removed creator"),
        (fx.alice, "account owner"),
        (fx.dana, "co-member"),
    ] {
        assert_eq!(
            datasets.is_visible_to(fx.d, who, &[]).await.unwrap(),
            require_dataset_read(&fx.pool, fx.d, who).await.is_ok(),
            "after removal, the two predicates must agree for {label}"
        );
    }
    // and the agreed answer for the removed creator is REFUSE — pinning the pair
    // to the correct value, not merely to each other.
    assert!(!datasets.is_visible_to(fx.d, fx.bob, &[]).await.unwrap());
    assert!(require_dataset_read(&fx.pool, fx.d, fx.bob).await.is_err());
}

// ===================== no-legitimate-access-lost personas =====================

/// TEST-14 [acceptance] [invariant: INV-11c] — PERSONA: **personal-account owner**.
///
/// The regression this fix could most easily cause is locking a solo user out of
/// their own data. A personal account's sole member IS its owner, so the
/// conjoined creator branch must fire exactly as before — through EVERY predicate
/// this branch touched, not just the headline one.
#[tokio::test]
async fn personal_account_owner_retains_every_access_they_had() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let solo = create_user(&server, &admin, "solo", "solo@x.test").await;
    let pool = pool_for(&server).await;
    let projects = ProjectRepository::new(pool.clone());
    let datasets = DatasetRepository::new(pool.clone());

    // A solo user with NO org membership at all — their resources live in the
    // personal account `create` stamps.
    let p = projects.create(solo, "mine", "").await.unwrap().id;
    let d = datasets
        .create(solo, "mine-ds", None, &serde_json::json!({}))
        .await
        .unwrap()
        .id;
    let f = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO files (id, user_id, filename, file_size, current_version_id, created_by) \
         VALUES ($1, $2, 'solo.csv', 10, $3, 'user')",
    )
    .bind(f)
    .bind(solo)
    .bind(Uuid::new_v4())
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO dataset_files (dataset_id, file_id, ordinal, role) \
         VALUES ($1, $2, 0, 'primary')",
    )
    .bind(d)
    .bind(f)
    .execute(&pool)
    .await
    .unwrap();

    assert_eq!(
        projects.effective_permission(p, solo).await.unwrap(),
        Some(EffectivePermission::Owner),
        "INV-11c: a personal-account owner is still Owner of their project"
    );
    let (list, total) = projects.list_visible(solo, None, 1, 50).await.unwrap();
    assert!(
        list.iter().any(|x| x.id == p) && total == 1,
        "INV-11c: and still lists it"
    );
    assert_eq!(
        list.iter()
            .find(|x| x.id == p)
            .unwrap()
            .effective_permission,
        "owner",
        "INV-11c: labelled owner"
    );
    assert!(
        datasets.is_visible_to(d, solo, &[]).await.unwrap(),
        "INV-11c: still reads their dataset"
    );
    assert_eq!(
        datasets.access(d, solo, &[]).await.unwrap(),
        DatasetAccess::CanEdit,
        "INV-11c: still edits it"
    );
    assert!(
        datasets
            .editable_subset(&[d], solo, &[])
            .await
            .unwrap()
            .contains(&d),
        "INV-11c: still in the editable subset"
    );
    assert!(
        require_dataset_read(&pool, d, solo).await.is_ok(),
        "INV-11c: still passes the workstore dataset gate"
    );
    assert!(
        require_project_read(&pool, p, solo).await.is_ok(),
        "INV-11c: still passes the workstore project gate"
    );
    assert!(
        file_readable_by(&pool, f, solo).await.unwrap(),
        "INV-11c: their sandbox still stages their own file"
    );
    let (mine, mine_total) = datasets.list_mine(solo, None, None, 1, 50).await.unwrap();
    assert!(
        mine.iter().any(|x| x.id == d) && mine_total == 1,
        "INV-11c: still lists their datasets"
    );
    assert!(
        datasets
            .artifact_summary_rows(solo, &[], 50, 5)
            .await
            .unwrap()
            .iter()
            .any(|r| r.0 == d),
        "INV-11c: still gets their artifact rollup"
    );
    // Destructive last — it consumes the dataset.
    assert!(
        datasets.delete(d, solo).await.unwrap(),
        "INV-11c: still deletes their own dataset"
    );
}

/// TEST-15 [acceptance] [invariant: INV-11c] — PERSONA: **current member who is a
/// creator**. A bare `member` of an org who CREATED a resource keeps the CREATOR's
/// authority over it (Owner / CanEdit), not merely their role's Viewer floor.
#[tokio::test]
async fn current_bare_member_who_created_a_resource_keeps_creator_authority() {
    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let projects = fx.projects();
    let datasets = fx.datasets();

    // No removal at all in this test — this is the steady state that must not move.
    assert_eq!(
        projects.effective_permission(fx.q, fx.dana).await.unwrap(),
        Some(EffectivePermission::Owner),
        "a bare member who CREATED the project is its Owner (not the Viewer floor)"
    );
    assert_eq!(
        datasets.access(fx.e, fx.dana, &[]).await.unwrap(),
        DatasetAccess::CanEdit,
        "a bare member who CREATED the dataset can edit it (not ViewOnly)"
    );
    // The contrast that proves the above is the CREATOR branch and not a widened
    // floor: on a resource dana did NOT create, she is exactly her role.
    assert_eq!(
        projects.effective_permission(fx.p, fx.dana).await.unwrap(),
        Some(EffectivePermission::Viewer),
        "and on someone else's project she is still only a Viewer"
    );
    assert_eq!(
        datasets.access(fx.d, fx.dana, &[]).await.unwrap(),
        DatasetAccess::ViewOnly,
        "and on someone else's dataset she is still only a viewer"
    );
}

/// TEST-16 — PERSONA: **current owner / admin / member (non-creator)**. The DEC-12
/// floors, untouched.
#[tokio::test]
async fn current_owner_admin_member_keep_their_dec12_floors() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let alice = create_user(&server, &admin, "alice", "alice@x.test").await;
    let adm = create_user(&server, &admin, "adm", "adm@x.test").await;
    let mem = create_user(&server, &admin, "mem", "mem@x.test").await;
    let pool = pool_for(&server).await;
    let projects = ProjectRepository::new(pool.clone());
    let datasets = DatasetRepository::new(pool.clone());

    let org = make_org_account(&pool, "Lab", alice).await;
    add_member(&pool, org, adm, "admin").await;
    add_member(&pool, org, mem, "member").await;

    // Created by ALICE. Note her own row is graded by the CREATOR branch (she made
    // it and is still a member), not by the account-role floor; the floor rungs are
    // graded on `adm` and `mem`, who created nothing. TEST-19 covers the account
    // `owner` rung on a NON-creator (`o2`), which is the arm alice cannot exercise.
    let p = projects.create(alice, "alices", "").await.unwrap().id;
    move_project_to_account(&pool, p, org).await;
    let d = datasets
        .create(alice, "alices-ds", None, &serde_json::json!({}))
        .await
        .unwrap()
        .id;
    move_dataset_to_account(&pool, d, org).await;

    assert_eq!(
        projects.effective_permission(p, alice).await.unwrap(),
        Some(EffectivePermission::Owner),
        "account owner → Owner"
    );
    assert_eq!(
        projects.effective_permission(p, adm).await.unwrap(),
        Some(EffectivePermission::Editor),
        "account admin → Editor"
    );
    assert_eq!(
        projects.effective_permission(p, mem).await.unwrap(),
        Some(EffectivePermission::Viewer),
        "account member → Viewer"
    );
    assert_eq!(
        datasets.access(d, adm, &[]).await.unwrap(),
        DatasetAccess::CanEdit,
        "account admin edits datasets"
    );
    assert_eq!(
        datasets.access(d, mem, &[]).await.unwrap(),
        DatasetAccess::ViewOnly,
        "account member is read-only"
    );
}

/// TEST-17 — PERSONA: **platform staff**. Offboarding must never strand a resource
/// beyond staff reach: the admin override fires precisely BECAUSE the fix turned
/// the ex-member's `perm` into `None`.
#[tokio::test]
async fn platform_staff_still_reach_a_removed_members_project() {
    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let projects = fx.projects();

    fx.remove_bob().await;

    // A project admin (the `project::admin::manage` / root-admin flag the endpoint
    // computes) reaches ANY existing project as Owner-equivalent.
    let scope = ProjectScope::resolve_admin_in_account(&projects, fx.p, fx.alice, true)
        .await
        .unwrap()
        .expect("platform staff must still reach the orphaned project");
    assert_eq!(scope.perm, EffectivePermission::Owner);

    // And for a staff user with NO ACL of their own — not a member of the org at
    // all — the reach comes from the OVERRIDE, flagged as such, not from a silent
    // widening of the predicate.
    let staff = create_user(&server, &fx.admin_token, "staff", "staff@x.test").await;
    let scope2 = ProjectScope::resolve_admin_in_account(&projects, fx.p, staff, true)
        .await
        .unwrap()
        .expect("platform staff with no ACL still reach the project");
    assert_eq!(scope2.perm, EffectivePermission::Owner);
    assert!(
        scope2.admin_override,
        "the reach is flagged as an admin override, not a real ACL"
    );

    // The removed member himself is still refused when the flag is FALSE (no
    // widening — R8).
    assert!(
        ProjectScope::resolve_admin_in_account(&projects, fx.p, fx.bob, false)
            .await
            .unwrap()
            .is_none(),
        "a removed member with no admin flag is still 404"
    );
}

/// TEST-19 [acceptance] [invariant: INV-D1] — #140's grant model is UNCHANGED.
///
/// This branch must close two holes without pre-empting the open owner decision
/// in #140. The mapping is asserted rather than left incidental: a bare account
/// `member` reaches ≥Viewer but NOT Editor on a project they neither own nor were
/// shared, and the owner/admin rungs still grade to Owner/Editor.
#[tokio::test]
async fn dec12_account_role_floor_is_unchanged() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let alice = create_user(&server, &admin, "alice", "alice@x.test").await;
    let o2 = create_user(&server, &admin, "owner2", "o2@x.test").await;
    let adm = create_user(&server, &admin, "adm", "adm@x.test").await;
    let mem = create_user(&server, &admin, "mem", "mem@x.test").await;
    let pool = pool_for(&server).await;
    let projects = ProjectRepository::new(pool.clone());

    let org = make_org_account(&pool, "Lab", alice).await;
    add_member(&pool, org, o2, "owner").await;
    add_member(&pool, org, adm, "admin").await;
    add_member(&pool, org, mem, "member").await;

    let p = projects.create(alice, "alices", "").await.unwrap().id;
    move_project_to_account(&pool, p, org).await;

    // The three arms of `account_role_floor`, on a project the principal neither
    // owns nor was shared.
    assert_eq!(
        projects.effective_permission(p, o2).await.unwrap(),
        Some(EffectivePermission::Owner),
        "INV-D1: account owner → EffectivePermission::Owner"
    );
    assert_eq!(
        projects.effective_permission(p, adm).await.unwrap(),
        Some(EffectivePermission::Editor),
        "INV-D1: account admin → Editor"
    );
    let member_perm = projects.effective_permission(p, mem).await.unwrap();
    assert_eq!(
        member_perm,
        Some(EffectivePermission::Viewer),
        "INV-D1: a bare account member reaches Viewer…"
    );
    assert!(
        !member_perm.unwrap().can_edit(),
        "INV-D1: …but NOT Editor — DEC-12 is not widened by this branch"
    );
}

/// TEST-13 [acceptance] [invariant: INV-1] — the FLIPPED characterization.
///
/// `fix/account-authz-holes` left this test asserting TODAY'S (defective) behaviour
/// for the two holes it deliberately did not fix, "so the filed issues have an
/// executable starting point and a later fix flips them VISIBLY rather than
/// silently". This is that fix (#167, #168), and this is that flip — the same three
/// calls on the same fixture, now reporting the closed answers.
///
/// It is kept as ONE test, in place, rather than deleted and re-written elsewhere:
/// the value of the parent's artifact is that the diff shows a `Control` becoming a
/// `None` and an ex-owner leaving two audiences, at the exact lines that recorded the
/// leak. Every assertion below is paired with a positive control on the same fixture,
/// because a flipped characterization is exactly where a vacuous pass hides.
#[tokio::test]
async fn the_two_filed_holes_are_closed() {
    use cytoanalyst::modules::dataset::sync::dataset_audience;
    use cytoanalyst::modules::jobs::authz::{resolve_job_reach, JobReach};
    use cytoanalyst::modules::jobs::models::Job;
    use cytoanalyst::modules::project::scope::project_audience;

    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;

    // A job whose CREATOR is bob (unlike the fixture's, which alice owns), and its
    // twin created by dana — the control that must keep working.
    let bobs_job = Uuid::new_v4();
    let danas_job = Uuid::new_v4();
    for (jid, owner, scope) in [(bobs_job, fx.bob, fx.d), (danas_job, fx.dana, fx.e)] {
        sqlx::query(
            "INSERT INTO jobs (id, owner_id, job_type, name, status, params, created_at, \
                               priority_class, resource_class) \
             VALUES ($1, $2, 'stub', 'j2', 'running', '{}', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'normal', \
                     'cpu-sandbox')",
        )
        .bind(jid)
        .bind(owner)
        .execute(&fx.pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO job_scope (job_id, scope_kind, scope_id) VALUES ($1, 'dataset', $2)",
        )
        .bind(jid)
        .bind(scope)
        .execute(&fx.pool)
        .await
        .unwrap();
    }

    let load = |jid: Uuid| {
        let pool = fx.pool.clone();
        async move {
            sqlx::query_as::<_, Job>("SELECT * FROM jobs WHERE id = $1")
                .bind(jid)
                .fetch_one(&pool)
                .await
                .unwrap()
        }
    };
    let bobs = load(bobs_job).await;
    let danas = load(danas_job).await;

    // PRECONDITION: bob controls his own job while he is still a member, so the deny
    // below is attributable to the removal and not to a job he never reached.
    assert_eq!(
        resolve_job_reach(&fx.pool, &bobs, fx.bob, false, &[])
            .await
            .unwrap(),
        JobReach::Control,
        "precondition: a CURRENT member controls the job they created"
    );

    fx.remove_bob().await;

    // #167 CLOSED — the creator short-circuit no longer survives removal.
    assert_eq!(
        resolve_job_reach(&fx.pool, &bobs, fx.bob, false, &[])
            .await
            .unwrap(),
        JobReach::None,
        "#167: a removed member no longer reaches — let alone CONTROLS — the job they \
         created inside the account. The creator arm is conjoined with standing on the \
         job's scope, which they no longer have"
    );
    // POSITIVE CONTROL: the identical shape, one still-current member over.
    assert_eq!(
        resolve_job_reach(&fx.pool, &danas, fx.dana, false, &[])
            .await
            .unwrap(),
        JobReach::Control,
        "positive control: a CURRENT bare member still controls the job they created \
         on the dataset they created — the arm was gated, not deleted"
    );
    // …and the admin arm is untouched, which is the other way this could have been
    // over-tightened.
    assert_eq!(
        resolve_job_reach(&fx.pool, &bobs, fx.bob, true, &[])
            .await
            .unwrap(),
        JobReach::Control,
        "positive control: platform staff still reach it — `is_admin` short-circuits \
         ahead of the creator arm"
    );

    // #168 CLOSED — the PROJECT audience.
    let (p_anchor, p_others) = project_audience(&fx.projects(), fx.p)
        .await
        .unwrap()
        .expect("the project still has a live audience — alice and dana remain members");
    let p_all: HashSet<Uuid> = p_others.iter().copied().chain([p_anchor]).collect();
    assert!(
        !p_all.contains(&fx.bob),
        "#168: the removed ex-creator is no longer in the project's sync fan-out, so \
         they stop being told in real time about a project they can no longer open"
    );
    assert!(
        p_all.contains(&fx.alice) && p_all.contains(&fx.dana),
        "positive control: the account's CURRENT members are the audience — \
         'bob is absent' is not an audience that reached nobody. (alice could always \
         open this project and was never told about it before; that is repaired here \
         in the same motion.)"
    );

    // #168 CLOSED — the DATASET audience (the sibling named in the issue's comment).
    let (d_anchor, d_others) = dataset_audience(&fx.pool, fx.d)
        .await
        .unwrap()
        .expect("the dataset still has a live audience");
    let d_all: HashSet<Uuid> = d_others.iter().copied().chain([d_anchor]).collect();
    assert!(
        !d_all.contains(&fx.bob),
        "#168: …and out of the DATASET fan-out too. Asserted by CALLING the audience, \
         not by reading `owner_of` — `owner_of` is deliberately left bare, so an \
         assertion on it would still pass with this fix reverted"
    );
    assert!(
        d_all.contains(&fx.alice) && d_all.contains(&fx.eve),
        "positive control: a current member AND the non-member edit-sharee are both \
         still in it — membership and the orthogonal share union both survive (#172 \
         is not answered here)"
    );
}

// ==================== #167 / #168 / #170 — the creator short-circuits ====================
//
// The residue `fix/account-authz-holes` filed and did not fix. Same discipline as
// above: every deny is paired, on the SAME fixture and through the SAME predicate,
// with a principal who MUST still be admitted — and here the controls carry extra
// weight, because each of the three issues names a legitimate case that the OBVIOUS
// patch breaks. A green deny with a red control is not a fix, it is a lockout.

/// Seed a `jobs` row owned by `owner`, optionally scoped. Returns its id.
/// (Deliberately raw SQL, like the fixture's own jobs: the create ROUTE would apply
/// its own admission gate and this suite is about the READ/CONTROL gates.)
async fn seed_job(pool: &SqlitePool, owner: Uuid, scope: Option<(&str, Uuid)>) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO jobs (id, owner_id, job_type, name, status, params, created_at, \
                           priority_class, resource_class) \
         VALUES ($1, $2, 'stub', 'sc', 'running', '{}', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'normal', 'cpu-sandbox')",
    )
    .bind(id)
    .bind(owner)
    .execute(pool)
    .await
    .expect("seed job");
    if let Some((kind, scope_id)) = scope {
        sqlx::query("INSERT INTO job_scope (job_id, scope_kind, scope_id) VALUES ($1, $2, $3)")
            .bind(id)
            .bind(kind)
            .bind(scope_id)
            .execute(pool)
            .await
            .expect("seed job scope");
    }
    id
}

async fn load_job(pool: &SqlitePool, id: Uuid) -> cytoanalyst::modules::jobs::models::Job {
    sqlx::query_as("SELECT * FROM jobs WHERE id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .expect("load job")
}

/// Seed a `files` row uploaded by `uploader`, optionally linked into `dataset`.
/// `files.user_id` is the UPLOADING ACTOR, which is the whole subject of #170.
async fn seed_file(pool: &SqlitePool, uploader: Uuid, dataset: Option<Uuid>) -> Uuid {
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO files (id, user_id, filename, file_size, current_version_id, created_by) \
         VALUES (randomblob(16), $1, 'seed.csv', 10, randomblob(16), 'user') RETURNING id",
    )
    .bind(uploader)
    .fetch_one(pool)
    .await
    .expect("seed file");
    if let Some(ds) = dataset {
        sqlx::query(
            "INSERT INTO dataset_files (dataset_id, file_id, ordinal, role) \
             VALUES ($1, $2, 99, 'primary')",
        )
        .bind(ds)
        .bind(id)
        .execute(pool)
        .await
        .expect("link file to dataset");
    }
    id
}

/// TEST-1 [acceptance] [invariant: INV-2] — #167, `resolve_job_reach`.
///
/// THE primary #167 site: `if is_admin || job.owner_id == user_id { Control }` fired
/// before anything asked whether the caller was still in the account. A removed member
/// therefore kept `Control` — the STOP gate, the raw log stream and the engine's raw
/// `error` string — over every job they had started inside the organization, forever.
#[tokio::test]
async fn removed_member_loses_control_of_the_job_they_created() {
    use cytoanalyst::modules::jobs::authz::{resolve_job_reach, JobReach};

    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;

    let bobs = seed_job(&fx.pool, fx.bob, Some(("dataset", fx.d))).await;
    let danas = seed_job(&fx.pool, fx.dana, Some(("dataset", fx.e))).await;
    let bobs_job = load_job(&fx.pool, bobs).await;
    let danas_job = load_job(&fx.pool, danas).await;

    assert_eq!(
        resolve_job_reach(&fx.pool, &bobs_job, fx.bob, false, &[])
            .await
            .unwrap(),
        JobReach::Control,
        "precondition: while he is a member, bob controls the job he created — so the \
         deny below is the removal and not a job he never reached"
    );

    fx.remove_bob().await;

    assert_eq!(
        resolve_job_reach(&fx.pool, &bobs_job, fx.bob, false, &[])
            .await
            .unwrap(),
        JobReach::None,
        "#167: a removed member no longer sees or stops the job they created on the \
         account's dataset"
    );

    // POSITIVE CONTROL — the load-bearing one. dana is a bare account `member`, and
    // her authority over her own job comes from the CREATOR arm, not from her member
    // role (a bare member floors at Viewer, which resolves to `None` here). She is
    // exactly the principal a careless fix locks out.
    assert_eq!(
        resolve_job_reach(&fx.pool, &danas_job, fx.dana, false, &[])
            .await
            .unwrap(),
        JobReach::Control,
        "positive control: a CURRENT bare member still controls the job they created — \
         the creator arm was gated, not removed"
    );
}

/// TEST-2 [acceptance] [invariant: INV-1] — #167, `JobRepository::list_visible_to`.
///
/// The SQL mirror of TEST-1, asserted on BOTH the page and the `total`: they are two
/// separate literals in the function and the pager promises pages that do not exist if
/// they disagree.
#[tokio::test]
async fn removed_member_no_longer_lists_the_job_they_created() {
    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let jobs = fx.jobs();

    let bobs = seed_job(&fx.pool, fx.bob, Some(("dataset", fx.d))).await;
    let danas = seed_job(&fx.pool, fx.dana, Some(("dataset", fx.e))).await;

    let (before, before_total) = jobs.list_visible_to(fx.bob, &[], None, 1, 50).await.unwrap();
    assert!(
        before.iter().any(|j| j.id == bobs),
        "precondition: bob lists the job he created"
    );
    assert!(
        before_total >= 1,
        "precondition: and the total counts it (page and total are separate SQL)"
    );

    fx.remove_bob().await;

    let (after, after_total) = jobs.list_visible_to(fx.bob, &[], None, 1, 50).await.unwrap();
    assert!(
        after.iter().all(|j| j.id != bobs),
        "#167: the job he created is gone from a removed member's page"
    );
    assert_eq!(
        after_total, 0,
        "#167: …and from the TOTAL — the two literals moved together"
    );

    // POSITIVE CONTROL: a still-current bare member lists (and counts) her own job.
    let (dana_page, dana_total) = jobs
        .list_visible_to(fx.dana, &[], None, 1, 50)
        .await
        .unwrap();
    assert!(
        dana_page.iter().any(|j| j.id == danas),
        "positive control: a current member still lists the job they created"
    );
    assert!(
        dana_total >= 1,
        "positive control: …and the total still counts it"
    );
}

/// TEST-3 — #167, `JobRepository::controllable_subset` (the batched `can_stop` grader
/// the list renders).
#[tokio::test]
async fn removed_member_is_absent_from_the_controllable_subset_for_their_own_job() {
    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let jobs = fx.jobs();

    let bobs = seed_job(&fx.pool, fx.bob, Some(("dataset", fx.d))).await;
    let danas = seed_job(&fx.pool, fx.dana, Some(("dataset", fx.e))).await;

    assert!(
        jobs.controllable_subset(&[bobs], fx.bob, &[])
            .await
            .unwrap()
            .contains(&bobs),
        "precondition: a current member may stop the job they created"
    );

    fx.remove_bob().await;

    assert_eq!(
        jobs.controllable_subset(&[bobs], fx.bob, &[]).await.unwrap(),
        HashSet::new(),
        "#167: a removed member may not stop the job they created"
    );
    assert!(
        jobs.controllable_subset(&[danas], fx.dana, &[])
            .await
            .unwrap()
            .contains(&danas),
        "positive control: a current bare member still may — the grader still GRADES"
    );
}

/// TEST-4 — #167, the PROJECT arm of all three graders.
///
/// Each of the three predicates has a dataset arm and a project arm; without this the
/// project arms could be reverted with TEST-1/2/3 still green.
#[tokio::test]
async fn removed_member_loses_the_project_scoped_job_they_created() {
    use cytoanalyst::modules::jobs::authz::{resolve_job_reach, JobReach};

    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let jobs = fx.jobs();

    let bobs = seed_job(&fx.pool, fx.bob, Some(("project", fx.p))).await;
    let danas = seed_job(&fx.pool, fx.dana, Some(("project", fx.q))).await;
    let bobs_job = load_job(&fx.pool, bobs).await;
    let danas_job = load_job(&fx.pool, danas).await;

    assert_eq!(
        resolve_job_reach(&fx.pool, &bobs_job, fx.bob, false, &[])
            .await
            .unwrap(),
        JobReach::Control,
        "precondition: a current member controls their project-scoped job"
    );

    fx.remove_bob().await;

    assert_eq!(
        resolve_job_reach(&fx.pool, &bobs_job, fx.bob, false, &[])
            .await
            .unwrap(),
        JobReach::None,
        "#167 (project arm): reach is gone"
    );
    let (page, total) = jobs.list_visible_to(fx.bob, &[], None, 1, 50).await.unwrap();
    assert!(
        page.iter().all(|j| j.id != bobs) && total == 0,
        "#167 (project arm): unlisted, page and total agreeing"
    );
    assert_eq!(
        jobs.controllable_subset(&[bobs], fx.bob, &[]).await.unwrap(),
        HashSet::new(),
        "#167 (project arm): and unstoppable"
    );

    // POSITIVE CONTROLS on the same three graders, one still-current member over.
    assert_eq!(
        resolve_job_reach(&fx.pool, &danas_job, fx.dana, false, &[])
            .await
            .unwrap(),
        JobReach::Control,
        "positive control (project arm): a current member still controls theirs"
    );
    let (dana_page, _) = jobs
        .list_visible_to(fx.dana, &[], None, 1, 50)
        .await
        .unwrap();
    assert!(
        dana_page.iter().any(|j| j.id == danas),
        "positive control (project arm): …still lists it"
    );
    assert!(
        jobs.controllable_subset(&[danas], fx.dana, &[])
            .await
            .unwrap()
            .contains(&danas),
        "positive control (project arm): …and still stops it"
    );
}

/// TEST-5 [acceptance] [invariant: INV-3] — #168, `project::scope::project_audience`.
///
/// The audience is a DELIVERY set, not an access gate, which is why #147's transform
/// did not repair it: after that branch a removed member correctly got 404 on every
/// project they created — and was still told, in real time, every time one changed.
#[tokio::test]
async fn removed_member_leaves_the_project_sync_audience() {
    use cytoanalyst::modules::project::scope::project_audience;

    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;

    // eve holds an ACCEPTED share on P — the orthogonal grant that must survive, and
    // the control that proves the audience is not simply empty.
    sqlx::query(
        "INSERT INTO project_shares (id, project_id, owner_id, recipient_id, \
                                     permission_level, status) \
         VALUES (randomblob(16), $1, $2, $3, 'editor', 'accepted')",
    )
    .bind(fx.p)
    .bind(fx.bob)
    .bind(fx.eve)
    .execute(&fx.pool)
    .await
    .expect("share P to eve");

    let flatten = |a: (Uuid, Vec<Uuid>)| -> HashSet<Uuid> {
        a.1.into_iter().chain([a.0]).collect()
    };

    let before = flatten(
        project_audience(&fx.projects(), fx.p)
            .await
            .unwrap()
            .expect("a live project has an audience"),
    );
    assert!(
        before.contains(&fx.bob),
        "precondition: the creating member is in his project's audience"
    );

    fx.remove_bob().await;

    let after = flatten(
        project_audience(&fx.projects(), fx.p)
            .await
            .unwrap()
            .expect("the project still has a live audience — alice and dana remain"),
    );
    assert!(
        !after.contains(&fx.bob),
        "#168: the removed ex-creator no longer receives the project's sync frames"
    );
    // POSITIVE CONTROLS — three of them, because "bob is absent" is satisfied by an
    // audience that reaches nobody, by one that lost its share arm, and by one that
    // lost its membership arm.
    assert!(
        after.contains(&fx.alice),
        "positive control: the account OWNER is in the audience"
    );
    assert!(
        after.contains(&fx.dana),
        "positive control: a bare current member is too — the audience is derived from \
         CURRENT membership (#168), which also repairs the pre-existing case of a \
         co-member who could open the project and was never told it changed"
    );
    assert!(
        after.contains(&fx.eve),
        "positive control: the accepted SHARE recipient survives, though she is not an \
         account member — a share is a separate grant and #172 is not answered here"
    );
}

/// TEST-6 [acceptance] [invariant: INV-3] — #168, `dataset::sync::dataset_audience`
/// (the sibling named in the issue's comment; a partial sweep is what produced the
/// inconsistency the issue reports).
#[tokio::test]
async fn removed_member_leaves_the_dataset_sync_audience() {
    use cytoanalyst::modules::dataset::sync::dataset_audience;

    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;

    let flatten = |a: (Uuid, Vec<Uuid>)| -> HashSet<Uuid> {
        a.1.into_iter().chain([a.0]).collect()
    };

    let before = flatten(
        dataset_audience(&fx.pool, fx.d)
            .await
            .unwrap()
            .expect("a live dataset has an audience"),
    );
    assert!(
        before.contains(&fx.bob),
        "precondition: the creating member is in his dataset's audience"
    );

    fx.remove_bob().await;

    let after = flatten(
        dataset_audience(&fx.pool, fx.d)
            .await
            .unwrap()
            .expect("the dataset still has a live audience"),
    );
    assert!(
        !after.contains(&fx.bob),
        "#168: the removed ex-creator no longer receives the dataset's sync frames"
    );
    assert!(
        after.contains(&fx.alice) && after.contains(&fx.dana),
        "positive control: the account's current members are the audience"
    );
    assert!(
        after.contains(&fx.eve),
        "positive control: and D's non-member edit-sharee is still in it"
    );
}

/// TEST-7 [acceptance] [invariant: INV-4] — #170, `sandbox::inputs::file_readable_by`.
///
/// **The highest-severity of the three: this one leaks BYTES, not metadata.** The
/// `f.user_id` branch is stamped with the UPLOADING ACTOR, so a removed member could
/// have a sandbox stage the raw contents of any file they had uploaded into the
/// organization's datasets — by naming it from a SCOPE-LESS analysis job, which the
/// job routes do not gate. The dataset itself 404'd for them; the bytes did not.
#[tokio::test]
async fn removed_members_sandbox_cannot_stage_the_bytes_they_uploaded() {
    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;

    // `fx.f` is a file BOB uploaded, linked to the org dataset D he created.
    // `danas_file` is the same shape one still-current member over.
    let danas_file = seed_file(&fx.pool, fx.dana, Some(fx.e)).await;

    assert!(
        file_readable_by(&fx.pool, fx.f, fx.bob).await.unwrap(),
        "precondition: while a member, bob's sandbox stages the file he uploaded"
    );

    fx.remove_bob().await;

    assert!(
        !file_readable_by(&fx.pool, fx.f, fx.bob).await.unwrap(),
        "#170: a removed member's sandbox can no longer stage the BYTES of a file they \
         uploaded into the organization's dataset — once a file is linked into a \
         dataset, the (membership-gated) dataset branch is its sole authority"
    );

    // POSITIVE CONTROLS on the same predicate and the same fixture.
    assert!(
        file_readable_by(&fx.pool, danas_file, fx.dana).await.unwrap(),
        "positive control: a CURRENT bare member still stages the file they uploaded \
         into the dataset they created"
    );
    assert!(
        file_readable_by(&fx.pool, fx.f, fx.alice).await.unwrap(),
        "positive control: the account OWNER still stages bob's file — it was revoked \
         from him, not deleted or orphaned"
    );
    assert!(
        file_readable_by(&fx.pool, fx.f, fx.eve).await.unwrap(),
        "positive control: D's non-member edit-sharee still stages it through the \
         share arm — the dataset branch keeps its orthogonal share union"
    );
}

/// TEST-8 [acceptance] [invariant: INV-7] — #170's LEGITIMATE case, preserved.
///
/// The issue states the obvious patch "breaks the legitimate case: a user's own
/// uploaded file, in no dataset at all, would stop being readable by their own
/// sandbox." This asserts it does not. Without this test the fix and the
/// over-tightening are indistinguishable.
#[tokio::test]
async fn a_removed_members_own_undatasetted_file_stays_readable_by_their_sandbox() {
    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;

    // Two files bob uploaded: one linked into the org dataset, one in NO dataset.
    let loose = seed_file(&fx.pool, fx.bob, None).await;
    let stranger_loose = seed_file(&fx.pool, fx.dana, None).await;

    fx.remove_bob().await;

    assert!(
        file_readable_by(&fx.pool, loose, fx.bob).await.unwrap(),
        "INV-7: a file in NO dataset is a personal file, and its uploader's own \
         sandbox still reads it — the conjunct fires only on a dataset-linked file"
    );
    assert!(
        !file_readable_by(&fx.pool, fx.f, fx.bob).await.unwrap(),
        "…while the dataset-LINKED file from the same uploader is refused: the two \
         differ by exactly the `dataset_files` link, which is the whole predicate"
    );
    // NEGATIVE CONTROL: the branch is still scoped to the UPLOADER, not open to all.
    assert!(
        !file_readable_by(&fx.pool, stranger_loose, fx.bob)
            .await
            .unwrap(),
        "negative control: someone else's loose file is still refused — the branch was \
         narrowed, not opened"
    );
}

/// TEST-9 [acceptance] [invariant: INV-6] — the OVER-TIGHTENING this fix must not be.
///
/// #167 names the regression the obvious patch causes: "a user who legitimately ran a
/// job on someone else's dataset through an `edit` share would lose their own job the
/// day that share is revoked." `eve` is that user — a NON-member with an `edit` share
/// on D. Requiring account MEMBERSHIP on the creator arm would strand her; requiring
/// STANDING does not.
#[tokio::test]
async fn an_edit_sharee_keeps_control_of_the_job_they_started() {
    use cytoanalyst::modules::jobs::authz::{resolve_job_reach, JobReach};

    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let jobs = fx.jobs();

    // A SECOND edit share, on dana's dataset E, which is NOT revoked below — so eve has
    // two dataset-scoped runs whose fates must differ.
    sqlx::query(
        "INSERT INTO dataset_shares (id, dataset_id, principal_type, principal_id, role) \
         VALUES (randomblob(16), $1, 'user', $2, 'edit')",
    )
    .bind(fx.e)
    .bind(fx.eve)
    .execute(&fx.pool)
    .await
    .expect("share E to eve");

    let eves = seed_job(&fx.pool, fx.eve, Some(("dataset", fx.d))).await;
    let eves_on_e = seed_job(&fx.pool, fx.eve, Some(("dataset", fx.e))).await;
    let eves_scopeless = seed_job(&fx.pool, fx.eve, None).await;
    let scoped = load_job(&fx.pool, eves).await;
    let on_e = load_job(&fx.pool, eves_on_e).await;
    let scopeless = load_job(&fx.pool, eves_scopeless).await;

    fx.remove_bob().await; // the account event under test happens around her

    assert_eq!(
        resolve_job_reach(&fx.pool, &scoped, fx.eve, false, &[])
            .await
            .unwrap(),
        JobReach::Control,
        "INV-6: an `edit`-role sharee is not an account member and never was, and she \
         still CONTROLS the run she started on the dataset shared with her. A \
         membership conjunct here would have taken her own job away"
    );
    assert!(
        jobs.controllable_subset(&[eves], fx.eve, &[])
            .await
            .unwrap()
            .contains(&eves),
        "INV-6: …and the batched grader agrees, so the list still renders her Stop \
         control"
    );
    assert_eq!(
        resolve_job_reach(&fx.pool, &scopeless, fx.eve, false, &[])
            .await
            .unwrap(),
        JobReach::Control,
        "INV-6: a SCOPE-LESS job stays creator-only and is unaffected — there is no \
         scope to have standing on"
    );

    // THE CONSEQUENCE #167 NAMES, asserted as what it is rather than dressed up as a
    // control. Revoking eve's share DOES take her own run away from her:
    //
    //   "a user who legitimately ran a job on someone else's dataset through an
    //    `edit` share would lose their own job the day that share is revoked"
    //
    // This branch does not design that away, and pretending this assertion is merely a
    // "negative control proving the conjunct is real" would be the exact rhetorical
    // move that hides a design divergence. It is asserted so it is VISIBLE, and so that
    // whoever answers #172 (does a share outlive membership, and does revoking one end
    // the sharee's authority over runs they made under it) flips this line deliberately.
    //
    // Why it ships anyway is argued in `creator_retains_standing`: every alternative
    // #167 offers is worse (option (a) strands eve IMMEDIATELY, not on revocation) or
    // needs a migration, and a revoked share is itself a deliberate revocation by the
    // dataset's owner.
    sqlx::query("DELETE FROM dataset_shares WHERE dataset_id = $1 AND principal_id = $2")
        .bind(fx.d)
        .bind(fx.eve)
        .execute(&fx.pool)
        .await
        .expect("revoke eve's share");
    assert_eq!(
        resolve_job_reach(&fx.pool, &scoped, fx.eve, false, &[])
            .await
            .unwrap(),
        JobReach::None,
        "#167's NAMED CONSEQUENCE, accepted and pinned: with the share revoked the \
         sharee loses Control of the run she started. Not a control assertion — a \
         recorded cost, and an owner decision (#172)"
    );
    // …and the loss is NARROW — scoped to the dataset whose share went away. Shown with
    // a SECOND dataset-scoped run of hers, on dataset E, whose share survived: if the
    // creator arm had collapsed into a blanket refusal of her runs, this would be `None`
    // too.
    //
    // (An earlier draft used her SCOPE-LESS job for this. That proves nothing: a job
    // with no `job_scope` row takes the `scope: None` branch, which never consults
    // `dataset_shares`, so the assertion was guaranteed by construction rather than by
    // the predicate — an idle control.)
    assert_eq!(
        resolve_job_reach(&fx.pool, &on_e, fx.eve, false, &[])
            .await
            .unwrap(),
        JobReach::Control,
        "…and it is narrow: her run on the dataset whose share SURVIVED is unaffected, \
         so the revocation took away exactly the run on the dataset she lost"
    );
}

/// TEST-10 [acceptance] [invariant: INV-8] — a SURVIVING share is not silently revoked.
///
/// #172 (whether a share should outlive membership) is an open owner decision. This
/// branch must not answer it by accident, in either direction — so a removed member
/// who still holds an `edit` share keeps exactly what that share grants, and the same
/// principal WITHOUT it is refused on all three surfaces.
#[tokio::test]
async fn a_removed_members_surviving_share_still_grants_what_it_granted() {
    use cytoanalyst::modules::dataset::sync::dataset_audience;
    use cytoanalyst::modules::jobs::authz::{resolve_job_reach, JobReach};

    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;

    // bob gets an `edit` share on the dataset he created, which SURVIVES his removal.
    sqlx::query(
        "INSERT INTO dataset_shares (id, dataset_id, principal_type, principal_id, role) \
         VALUES (randomblob(16), $1, 'user', $2, 'edit')",
    )
    .bind(fx.d)
    .bind(fx.bob)
    .execute(&fx.pool)
    .await
    .expect("share D to bob");

    let bobs = seed_job(&fx.pool, fx.bob, Some(("dataset", fx.d))).await;
    let bobs_job = load_job(&fx.pool, bobs).await;

    fx.remove_bob().await;

    assert_eq!(
        resolve_job_reach(&fx.pool, &bobs_job, fx.bob, false, &[])
            .await
            .unwrap(),
        JobReach::Control,
        "INV-8: the surviving share is standing, so he keeps CONTROL of the run he \
         started — this branch does not revoke a grant #172 has not decided about"
    );
    let (anchor, others) = dataset_audience(&fx.pool, fx.d)
        .await
        .unwrap()
        .expect("audience");
    let audience: HashSet<Uuid> = others.into_iter().chain([anchor]).collect();
    assert!(
        audience.contains(&fx.bob),
        "INV-8: …and he is still in the dataset's sync audience through the share arm"
    );
    assert!(
        file_readable_by(&fx.pool, fx.f, fx.bob).await.unwrap(),
        "INV-8: …and his sandbox still stages the dataset's files through the dataset \
         branch's share union"
    );

    // NEGATIVE CONTROL — the same removed principal, with the share dropped, is
    // refused on all three. Without this, the three admits above are indistinguishable
    // from a fix that never applied.
    sqlx::query("DELETE FROM dataset_shares WHERE dataset_id = $1 AND principal_id = $2")
        .bind(fx.d)
        .bind(fx.bob)
        .execute(&fx.pool)
        .await
        .expect("drop bob's share");
    assert_eq!(
        resolve_job_reach(&fx.pool, &bobs_job, fx.bob, false, &[])
            .await
            .unwrap(),
        JobReach::None,
        "negative control: without the share the same removed member is refused"
    );
    let (anchor2, others2) = dataset_audience(&fx.pool, fx.d)
        .await
        .unwrap()
        .expect("audience");
    let audience2: HashSet<Uuid> = others2.into_iter().chain([anchor2]).collect();
    assert!(
        !audience2.contains(&fx.bob),
        "negative control: …and out of the audience"
    );
    assert!(
        !file_readable_by(&fx.pool, fx.f, fx.bob).await.unwrap(),
        "negative control: …and out of the bytes"
    );
}

/// TEST-11 [acceptance] [invariant: INV-5] — PERSONAL accounts are unaffected.
///
/// #147 disposition (c) is safe to apply at a chokepoint precisely because "their
/// single member *is* the owner, so the owner branch fires exactly as before". This
/// asserts that for all six predicates this branch edits, on a solo user who has
/// never seen an organization.
#[tokio::test]
async fn a_personal_account_owner_is_unaffected_by_every_gate_on_this_branch() {
    use cytoanalyst::modules::dataset::sync::dataset_audience;
    use cytoanalyst::modules::jobs::authz::{resolve_job_reach, JobReach};
    use cytoanalyst::modules::project::scope::project_audience;

    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let solo = create_user(&server, &admin, "solo167", "solo167@x.test").await;
    let pool = pool_for(&server).await;

    let projects = ProjectRepository::new(pool.clone());
    let datasets = DatasetRepository::new(pool.clone());
    let jobs = JobRepository::new(pool.clone());

    // `create` stamps the owner's PERSONAL account, whose only member is the owner.
    let p = projects.create(solo, "solo-project", "").await.unwrap().id;
    let d = datasets
        .create(solo, "solo-dataset", None, &serde_json::json!({}))
        .await
        .unwrap()
        .id;
    let f = seed_file(&pool, solo, Some(d)).await;
    let dj = seed_job(&pool, solo, Some(("dataset", d))).await;
    let pj = seed_job(&pool, solo, Some(("project", p))).await;
    let loose = seed_job(&pool, solo, None).await;

    for (id, what) in [(dj, "dataset-scoped"), (pj, "project-scoped"), (loose, "scope-less")] {
        let job = load_job(&pool, id).await;
        assert_eq!(
            resolve_job_reach(&pool, &job, solo, false, &[]).await.unwrap(),
            JobReach::Control,
            "INV-5: a personal-account owner still controls their {what} job"
        );
        assert!(
            jobs.controllable_subset(&[id], solo, &[])
                .await
                .unwrap()
                .contains(&id),
            "INV-5: …and the batched grader agrees for the {what} job"
        );
    }
    let (page, total) = jobs.list_visible_to(solo, &[], None, 1, 50).await.unwrap();
    assert_eq!(page.len(), 3, "INV-5: all three of their jobs are listed");
    assert_eq!(total, 3, "INV-5: …page and total agree");

    let (p_anchor, p_others) = project_audience(&projects, p)
        .await
        .unwrap()
        .expect("INV-5: a solo owner is their own audience, never None");
    assert_eq!(p_anchor, solo, "INV-5: they anchor their project's fan-out");
    assert!(
        p_others.is_empty(),
        "INV-5: and there is nobody else — a valid fan-to-self, byte-identical to before"
    );
    let (d_anchor, d_others) = dataset_audience(&pool, d)
        .await
        .unwrap()
        .expect("INV-5: …and their dataset's");
    assert_eq!(d_anchor, solo);
    assert!(d_others.is_empty());

    assert!(
        file_readable_by(&pool, f, solo).await.unwrap(),
        "INV-5: and their sandbox still stages the file they uploaded into their own \
         dataset — via the dataset branch, since a personal account's sole member IS \
         the owner"
    );
}

/// TEST-12 — the KNOWN RESIDUE, asserted rather than left silent (DEC-3).
///
/// #167 option (a) is "gate the creator arm on the scope's account membership, and
/// **leave scope-less jobs creator-only**". A scope-less job has no second principal
/// and `jobs` has no `account_id`, so there is no membership to require. Closing it
/// needs option (b) (a `jobs.account_id`), which is a migration and a stamping change
/// on every creation path — out of scope here, and recorded so a later decision flips
/// this test rather than changing behaviour quietly.
#[tokio::test]
async fn a_scope_less_job_stays_creator_only_even_after_removal() {
    use cytoanalyst::modules::jobs::authz::{resolve_job_reach, JobReach};

    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let jobs = fx.jobs();

    let bobs = seed_job(&fx.pool, fx.bob, None).await;
    let danas = seed_job(&fx.pool, fx.dana, None).await;
    let bobs_job = load_job(&fx.pool, bobs).await;
    let danas_job = load_job(&fx.pool, danas).await;

    fx.remove_bob().await;

    assert_eq!(
        resolve_job_reach(&fx.pool, &bobs_job, fx.bob, false, &[])
            .await
            .unwrap(),
        JobReach::Control,
        "RESIDUE (DEC-3, #167 option (a)): a removed member still reaches a SCOPE-LESS \
         job they created. Metadata only — the byte path a scope-less job could reach \
         is closed separately by #170 at the file gate"
    );
    assert!(
        jobs.controllable_subset(&[bobs], fx.bob, &[])
            .await
            .unwrap()
            .contains(&bobs),
        "RESIDUE: the SQL grader agrees with the Rust gate on the residue too — the \
         two must not disagree even where the behaviour is known-imperfect"
    );
    // CONTROL: the assertion is about SCOPE-LESSNESS, not about the removal — a
    // current member's scope-less job behaves identically.
    assert_eq!(
        resolve_job_reach(&fx.pool, &danas_job, fx.dana, false, &[])
            .await
            .unwrap(),
        JobReach::Control,
        "control: a current member's scope-less job behaves the same, so the residue \
         above is the scope-less arm and not a removal that failed to apply"
    );
    // …and a scoped job by the same removed member IS refused, on the same fixture.
    let scoped = seed_job(&fx.pool, fx.bob, Some(("dataset", fx.d))).await;
    let scoped_job = load_job(&fx.pool, scoped).await;
    assert_eq!(
        resolve_job_reach(&fx.pool, &scoped_job, fx.bob, false, &[])
            .await
            .unwrap(),
        JobReach::None,
        "control: the SCOPED sibling of the same job, same creator, same removal, is \
         refused — the residue is exactly scope-lessness"
    );
}

/// TEST-14 — the three graders still AGREE, on the two principals this branch moves.
///
/// `list_visible_to` (SQL), `controllable_subset` (SQL) and `resolve_job_reach` (Rust)
/// are three implementations of one rule, and all three moved here. The suite already
/// holds them to each other on the pre-existing personas
/// (`a_job_is_listed_exactly_when_it_can_be_opened`,
/// `the_batched_stop_grader_and_the_per_job_gate_agree`); this adds the two the branch
/// introduces — a REMOVED creator and a NON-MEMBER edit-sharee creator — across both
/// scope kinds and a scope-less job.
///
/// ONE principal is DELIBERATELY absent from this matrix, and its absence is stated
/// here so it is not mistaken for an oversight: an account `admin`/`owner` who did not
/// create the scope row. `resolve_job_reach` reaches them (through `access`'s
/// account-role union) while `list_visible_to` does not (it requires
/// `d.owner_id = $1 AND member`, or an `edit` share). The two graders therefore
/// genuinely disagree for that principal — a PRE-EXISTING #147-era divergence, not one
/// this branch introduces, and closing it would be a WIDENING of who sees raw job logs
/// rather than a fix. Adding them here would turn this test red over behaviour the
/// branch does not touch; it is reported to the owner instead.
#[tokio::test]
async fn the_three_jobs_graders_agree_on_the_removed_and_shared_creators() {
    use cytoanalyst::modules::jobs::authz::{resolve_job_reach, JobReach};

    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let jobs = fx.jobs();

    let cases = [
        ("bob/dataset", fx.bob, seed_job(&fx.pool, fx.bob, Some(("dataset", fx.d))).await),
        ("bob/project", fx.bob, seed_job(&fx.pool, fx.bob, Some(("project", fx.p))).await),
        ("bob/scope-less", fx.bob, seed_job(&fx.pool, fx.bob, None).await),
        ("eve/dataset", fx.eve, seed_job(&fx.pool, fx.eve, Some(("dataset", fx.d))).await),
        ("eve/scope-less", fx.eve, seed_job(&fx.pool, fx.eve, None).await),
        ("dana/dataset", fx.dana, seed_job(&fx.pool, fx.dana, Some(("dataset", fx.e))).await),
    ];

    fx.remove_bob().await;

    let mut saw_control = false;
    let mut saw_none = false;
    for (who, principal, job_id) in cases {
        let job = load_job(&fx.pool, job_id).await;
        let reach = resolve_job_reach(&fx.pool, &job, principal, false, &[])
            .await
            .unwrap();
        let (page, _total) = jobs
            .list_visible_to(principal, &[], None, 1, 100)
            .await
            .unwrap();
        let listed = page.iter().any(|j| j.id == job_id);
        let stoppable = jobs
            .controllable_subset(&[job_id], principal, &[])
            .await
            .unwrap()
            .contains(&job_id);

        assert_eq!(
            listed,
            reach.can_see(),
            "{who}: `list_visible_to` and `resolve_job_reach` disagree — a job listed \
             but not openable (or openable but unlisted) is the drift the SQL mirror \
             exists to avoid"
        );
        assert_eq!(
            stoppable,
            reach.can_control(),
            "{who}: `controllable_subset` and `resolve_job_reach` disagree — the list \
             would render a Stop control that answers 403, or hide one that works"
        );
        match reach {
            JobReach::Control => saw_control = true,
            JobReach::None => saw_none = true,
            JobReach::See => {}
        }
    }
    // Negative controls: an invariant satisfied by "everything is Control" or
    // "everything is None" proves nothing about the graders agreeing.
    assert!(saw_control, "some principal controls some job in this matrix");
    assert!(saw_none, "and some principal reaches none — the matrix GRADES");
}

/// TEST-15 — platform staff are unaffected.
///
/// `is_admin` short-circuits ahead of the creator arm, deliberately: an admin
/// transcends tenancy on every other surface in this codebase and must here too. The
/// other way this branch could have over-tightened.
#[tokio::test]
async fn platform_staff_still_reach_a_removed_members_job() {
    use cytoanalyst::modules::jobs::authz::{resolve_job_reach, JobReach};

    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;

    let bobs = seed_job(&fx.pool, fx.bob, Some(("dataset", fx.d))).await;
    let bobs_job = load_job(&fx.pool, bobs).await;

    fx.remove_bob().await;

    assert_eq!(
        resolve_job_reach(&fx.pool, &bobs_job, fx.bob, true, &[])
            .await
            .unwrap(),
        JobReach::Control,
        "platform staff still control the job — `is_admin` is evaluated BEFORE the \
         creator arm and is untouched by #167"
    );
    // …and the non-admin call on the SAME row is refused, so the admit above is the
    // admin flag and not a gate that stopped gating.
    assert_eq!(
        resolve_job_reach(&fx.pool, &bobs_job, fx.bob, false, &[])
            .await
            .unwrap(),
        JobReach::None,
        "control: the same row, same principal, without the admin flag, is refused"
    );
    // The admin LIST path is a different query (`list_all`) and is unfiltered by
    // design; assert it still returns the row, so staff can still triage it.
    let (all, total) = fx.jobs().list_all(None, 1, 100).await.unwrap();
    assert!(
        all.iter().any(|j| j.id == bobs) && total >= 1,
        "positive control: the admin listing still returns a removed member's job"
    );
}

/// TEST-17 [acceptance] [invariant: INV-3] — FOURTH INSTANCE (a):
/// `JobRepository::visible_to_user_ids`, the JOBS sync audience.
///
/// Found by this branch's blind sweep, named by NEITHER issue. The dataset/project
/// arms of this query were hardened by #147; the JOB's own creator was returned
/// unconditionally from a bare `SELECT owner_id FROM jobs`, and the sink then put that
/// id in the fan-out's owner slot. So a removed member could not open the account's
/// jobs and was still told, live, on every transition — a continuous activity oracle
/// over the organization's compute. It is #167's creator short-circuit living inside
/// #168's audience.
#[tokio::test]
async fn removed_member_leaves_the_audience_of_the_job_they_created() {
    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;

    let bobs = seed_job(&fx.pool, fx.bob, Some(("dataset", fx.d))).await;
    let danas = seed_job(&fx.pool, fx.dana, Some(("dataset", fx.e))).await;
    let bobs_loose = seed_job(&fx.pool, fx.bob, None).await;

    let flatten = |a: (Uuid, Vec<Uuid>)| -> HashSet<Uuid> {
        a.1.into_iter().chain([a.0]).collect()
    };

    let before = flatten(
        JobRepository::visible_to_user_ids(&fx.pool, bobs)
            .await
            .unwrap()
            .expect("a job with a live scope has an audience"),
    );
    assert!(
        before.contains(&fx.bob),
        "precondition: the creator is in his own job's audience while he is a member"
    );

    fx.remove_bob().await;

    let after = flatten(
        JobRepository::visible_to_user_ids(&fx.pool, bobs)
            .await
            .unwrap()
            .expect("the job still has an audience — alice and eve reach it"),
    );
    assert!(
        !after.contains(&fx.bob),
        "FOURTH INSTANCE (a): the removed creator no longer receives his own job's \
         live frames"
    );
    assert!(
        after.contains(&fx.eve),
        "positive control: D's edit-sharee is still in it — 'bob is absent' is not an \
         audience that reached nobody. (The JOB audience deliberately mirrors \
         `list_visible_to`, i.e. the EDIT level — D's owner-if-still-a-member plus its \
         edit-sharees — and NOT the account-membership floor `resolve_job_reach` \
         reaches through `access`. That asymmetry is pre-existing and is not widened \
         or narrowed here; alice is absent for that reason, not because of #167.)"
    );

    let danas_audience = flatten(
        JobRepository::visible_to_user_ids(&fx.pool, danas)
            .await
            .unwrap()
            .expect("audience"),
    );
    assert!(
        danas_audience.contains(&fx.dana),
        "positive control: a CURRENT member still receives frames for the job they \
         created — the creator anchor was gated, not deleted"
    );

    // The residue and the audience must AGREE: TEST-12 pins that a removed member
    // still REACHES a scope-less job they created, so they must still be TOLD about
    // it. A row a user can open and is never notified about sits stale until a manual
    // reload, which is the defect this whole audience exists to prevent.
    let loose_audience = flatten(
        JobRepository::visible_to_user_ids(&fx.pool, bobs_loose)
            .await
            .unwrap()
            .expect("a scope-less job's audience is its creator"),
    );
    assert!(
        loose_audience.contains(&fx.bob),
        "consistency with DEC-3: the scope-less residue is reachable, so it is also \
         notified — the gate and the audience agree even on the known-imperfect case"
    );
}

/// TEST-19 — ITEM-10, the adjacent defect in the predicate #170 rewrites.
///
/// `file_readable_by`'s group-share disjunct resolved groups through `user_groups`
/// ALONE, while its documented lock-step twin `workstore::authz::require_dataset_read`
/// filters to ACTIVE groups. A member of a DISABLED group therefore kept staging that
/// dataset's bytes into a sandbox after every other gate had revoked them. This is the
/// same defect `799d0cf3` collapsed five hand-copies of; this was a sixth, and it sat
/// inside the one predicate on this branch that carries actual file CONTENT.
#[tokio::test]
async fn a_disabled_groups_member_cannot_stage_the_datasets_bytes() {
    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    // Reuse the fixture's admin token — `setup_admin` is one-shot per server (a second
    // call 403s on an already-provisioned instance).
    let grouped = create_user(&server, &fx.admin_token, "grouped170", "grouped170@x.test").await;

    let group: Uuid = sqlx::query_scalar(
        "INSERT INTO groups (id, name, description, permissions, is_active) \
         VALUES (randomblob(16), 'shared-170', '', '{}', true) RETURNING id",
    )
    .fetch_one(&fx.pool)
    .await
    .expect("seed group");
    sqlx::query("INSERT INTO user_groups (user_id, group_id) VALUES ($1, $2)")
        .bind(grouped)
        .bind(group)
        .execute(&fx.pool)
        .await
        .expect("assign to group");
    sqlx::query(
        "INSERT INTO dataset_shares (id, dataset_id, principal_type, principal_id, role) \
         VALUES (randomblob(16), $1, 'group', $2, 'view')",
    )
    .bind(fx.d)
    .bind(group)
    .execute(&fx.pool)
    .await
    .expect("group-share D");

    // POSITIVE CONTROL FIRST: while the group is ACTIVE the share works, on BOTH
    // gates. Asserting only the post-deactivation refusal would pass against a
    // fixture whose share never granted anything.
    assert!(
        file_readable_by(&fx.pool, fx.f, grouped).await.unwrap(),
        "positive control: an ACTIVE group's member stages the shared dataset's file"
    );
    assert!(
        require_dataset_read(&fx.pool, fx.d, grouped)
            .await
            .is_ok(),
        "positive control: …and the lock-step twin admits them too"
    );

    sqlx::query("UPDATE groups SET is_active = false WHERE id = $1")
        .bind(group)
        .execute(&fx.pool)
        .await
        .expect("deactivate the group");

    assert!(
        !file_readable_by(&fx.pool, fx.f, grouped).await.unwrap(),
        "ITEM-10: deactivating the group revokes the BYTES too — the group arm now \
         carries the `groups.is_active` filter its documented lock-step twin has"
    );
    assert!(
        require_dataset_read(&fx.pool, fx.d, grouped)
            .await
            .is_err(),
        "…and the twin refuses on the same principal, which is the lock-step this \
         predicate's doc comment claims"
    );
    // And the rest of the predicate is untouched: a current account member still reads.
    assert!(
        file_readable_by(&fx.pool, fx.f, fx.alice).await.unwrap(),
        "control: the account owner is unaffected — only the group arm moved"
    );
}

/// TEST-18 [acceptance] [invariant: INV-3] — FOURTH INSTANCE (b): the INLINED
/// audiences, proven at the ROUTE.
///
/// Seven handlers derived their fan-out from `row.owner_id + accepted_recipient_ids /
/// sharee_user_ids` and never called `project_audience` / `dataset_audience` at all,
/// so fixing the two helpers alone would have left every user-facing mutation still
/// addressing the removed ex-creator. #168 says so directly: "any other
/// `fan_out_owner_scoped` caller that derives its audience from an `owner_id` should
/// be swept at the same time … a partial sweep is what produced the current
/// inconsistency."
///
/// Driven over the real HTTP routes with live SSE subscriptions, because the defect
/// lived in the HANDLERS and not in any predicate: asserting the helper's return value
/// would pass with all seven call sites untouched. The probes are opened AFTER the
/// removal so nothing in the stream predates the state under test.
#[tokio::test]
async fn removed_member_receives_no_frames_from_the_project_and_dataset_routes() {
    use crate::common::sync_probe::SyncProbe;
    use std::time::Duration;

    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;

    fx.remove_bob().await;

    let alice_token = super::login(&server, "alice").await;
    let bob_token = super::login(&server, "bob").await;
    let dana_token = super::login(&server, "dana").await;

    let mut bob_probe = SyncProbe::open(&server, &bob_token).await;
    let mut dana_probe = SyncProbe::open(&server, &dana_token).await;
    // alice is the account OWNER and neither the actor nor a sharee on dana's dataset —
    // the principal the pre-#168 audience silently excluded from a delete she could see.
    let mut alice_probe = SyncProbe::open(&server, &alice_token).await;

    // A CURRENT member renames the project BOB created. (bob cannot: he 404s.)
    let renamed = server
        .client
        .post(server.api_url(&format!("/projects/{}", fx.p)))
        .bearer_auth(&alice_token)
        .json(&serde_json::json!({ "name": "renamed-by-alice" }))
        .send()
        .await
        .expect("rename project");
    assert_eq!(
        renamed.status().as_u16(),
        200,
        "precondition: a current account owner may still rename the project"
    );

    // POSITIVE CONTROL FIRST: the route really does emit. Without this, bob's silence
    // below is indistinguishable from a handler that publishes nothing at all.
    dana_probe
        .expect_event_for("project", "update", &fx.p.to_string(), Duration::from_secs(5))
        .await;

    // A CURRENT member renames the dataset BOB created.
    let renamed_ds = server
        .client
        .put(server.api_url(&format!("/datasets/{}", fx.d)))
        .bearer_auth(&alice_token)
        .json(&serde_json::json!({ "name": "renamed-ds" }))
        .send()
        .await
        .expect("rename dataset");
    assert_eq!(
        renamed_ds.status().as_u16(),
        200,
        "precondition: …and the dataset"
    );
    dana_probe
        .expect_event_for("dataset", "update", &fx.d.to_string(), Duration::from_secs(5))
        .await;

    // ATTACH + DETACH — two more converted handlers, each with its own emit site.
    for (method_is_post, what) in [(true, "attach"), (false, "detach")] {
        let url = server.api_url(&format!("/projects/{}/datasets/{}", fx.p, fx.d2));
        let req = if method_is_post {
            server.client.post(url)
        } else {
            server.client.delete(url)
        };
        let r = req
            .bearer_auth(&alice_token)
            .send()
            .await
            .expect("attach/detach");
        assert_eq!(
            r.status().as_u16(),
            200,
            "precondition: a current member may {what} a dataset"
        );
        dana_probe
            .expect_event_for("project", "update", &fx.p.to_string(), Duration::from_secs(5))
            .await;
    }

    // DATASET DELETE — the dataset family's own before-the-mutation site (it cannot
    // share `publish_dataset_audience`: the audience must outlive the cascading
    // shares), so the rename leg above does not cover it.
    //
    // This leg is the DELIVERY half of #168 rather than the deny half, and the
    // principal that makes it non-vacuous is ALICE: she is neither the actor nor a
    // sharee of dana's dataset, so the pre-#168 audience (`auth.user.id ∪
    // sharee_user_ids`) reached her with nothing, while she could open the dataset the
    // whole time. Driven as DANA on her own dataset because `delete_dataset` is
    // owner-gated and E's owner is dana.
    let ds_deleted = server
        .client
        .delete(server.api_url(&format!("/datasets/{}", fx.e)))
        .bearer_auth(&dana_token)
        .send()
        .await
        .expect("delete dataset");
    assert_eq!(
        ds_deleted.status().as_u16(),
        204,
        "precondition: a dataset's creator may delete it"
    );
    alice_probe
        .expect_event_for("dataset", "delete", &fx.e.to_string(), Duration::from_secs(5))
        .await;

    // ADMIN PROJECT DELETE — a SEPARATE handler (`admin_handlers::perform_delete`) with
    // its own inlined audience, on a path no owner-facing test reaches. Driven on a
    // second bob-created project so the owner-delete leg below still has one.
    let p2: Uuid = sqlx::query_scalar(
        "INSERT INTO projects (id, owner_id, account_id, name, description)          VALUES (randomblob(16), $1, $2, 'bobs-second', '') RETURNING id",
    )
    .bind(fx.bob)
    .bind(fx.org)
    .fetch_one(&fx.pool)
    .await
    .expect("seed a second bob-created project in the org");
    let admin_deleted = server
        .client
        .delete(server.api_url(&format!("/admin/projects/{p2}")))
        .bearer_auth(&fx.admin_token)
        .send()
        .await
        .expect("admin delete project");
    assert_eq!(
        admin_deleted.status().as_u16(),
        204,
        "precondition: platform staff may delete any project"
    );
    dana_probe
        .expect_event_for("project", "delete", &p2.to_string(), Duration::from_secs(5))
        .await;

    // DELETE — the one owner-facing site that must capture its audience BEFORE the row
    // (and its cascading shares) are gone, so it does not share the helper the others
    // use.
    let deleted = server
        .client
        .delete(server.api_url(&format!("/projects/{}", fx.p)))
        .bearer_auth(&alice_token)
        .send()
        .await
        .expect("delete project");
    assert_eq!(
        deleted.status().as_u16(),
        204,
        "precondition: the account owner may delete it"
    );
    dana_probe
        .expect_event_for("project", "delete", &fx.p.to_string(), Duration::from_secs(5))
        .await;

    // THE DENY: bob, the removed ex-creator of every row above, was told nothing by ANY
    // of those seven routes — four owner-facing project handlers, two dataset handlers
    // and the platform-admin delete. Checked last so every emit has certainly already
    // been fanned (dana received all seven), which is what makes the silence a real
    // absence rather than a race the probe won.
    bob_probe.expect_silence(Duration::from_secs(2)).await;

    // LIVENESS — the assertion above would ALSO hold if bob's stream had simply been
    // torn down: `expect_silence` treats a closed channel as success, and the sync
    // subscription re-checks entitlement periodically. So prove the stream was alive
    // the whole time by driving a mutation bob IS entitled to — a project in his own
    // PERSONAL account, which his removal from the org did not touch — and requiring
    // him to receive it on the SAME probe.
    let bobs_own = server
        .client
        .post(server.api_url("/projects"))
        .bearer_auth(&bob_token)
        .json(&serde_json::json!({ "name": "bobs-personal", "description": "" }))
        .send()
        .await
        .expect("create bob's own project");
    assert_eq!(
        bobs_own.status().as_u16(),
        201,
        "bob is still a normal user of his own personal account"
    );
    let own_id = bobs_own.json::<serde_json::Value>().await.expect("json")["id"]
        .as_str()
        .expect("id")
        .to_string();
    bob_probe
        .expect_event_for("project", "create", &own_id, Duration::from_secs(5))
        .await;
}

/// TEST-20 — the GROUP-SHARE arm of the three jobs graders.
///
/// The standing conjunct this branch added to `list_visible_to` (page AND total) and
/// to `controllable_subset` admits an ACTIVE-group dataset share, and
/// `controllable_subset` gained a `group_ids` parameter (a new `$3`) purely to carry
/// it. Every other test in this suite passes `&[]`, so without this one that whole
/// disjunct — and the new parameter index — would ship with no coverage at all: a
/// dropped group arm or an off-by-one bind would be green.
///
/// The subject's ONLY standing on the dataset is the group share, so each admit below
/// is attributable to that arm alone.
#[tokio::test]
async fn a_group_share_is_standing_for_the_creator_arm_in_all_three_graders() {
    use cytoanalyst::modules::jobs::authz::{resolve_job_reach, JobReach};

    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let jobs = fx.jobs();

    // `grouped` is NOT an account member and holds NO direct share — only membership
    // of a group that D is shared with.
    let grouped = create_user(&server, &fx.admin_token, "grp167", "grp167@x.test").await;
    let group: Uuid = sqlx::query_scalar(
        "INSERT INTO groups (id, name, description, permissions, is_active) \
         VALUES (randomblob(16), 'shared-167', '', '{}', true) RETURNING id",
    )
    .fetch_one(&fx.pool)
    .await
    .expect("seed group");
    sqlx::query("INSERT INTO user_groups (user_id, group_id) VALUES ($1, $2)")
        .bind(grouped)
        .bind(group)
        .execute(&fx.pool)
        .await
        .expect("assign to group");
    // A **`view`** group share, not `edit`, and that choice is load-bearing. Standing is
    // the VISIBILITY predicate, so a `view` share satisfies it — while `list_visible_to`'s
    // pre-existing scope arm and `controllable_subset`'s scope arm both require an `edit`
    // share (or row ownership). With an `edit` share every admit below would ALSO be
    // produced by those pre-existing arms, and deleting the group disjunct from the
    // creator arm would leave this test green: a confounded control proving nothing.
    sqlx::query(
        "INSERT INTO dataset_shares (id, dataset_id, principal_type, principal_id, role) \
         VALUES (randomblob(16), $1, 'group', $2, 'view')",
    )
    .bind(fx.d)
    .bind(group)
    .execute(&fx.pool)
    .await
    .expect("group-share D");

    let theirs = seed_job(&fx.pool, grouped, Some(("dataset", fx.d))).await;
    let job = load_job(&fx.pool, theirs).await;
    let groups = [group];

    assert_eq!(
        resolve_job_reach(&fx.pool, &job, grouped, false, &groups)
            .await
            .unwrap(),
        JobReach::Control,
        "the Rust gate: a GROUP share is standing, so the creator keeps Control"
    );
    let (page, total) = jobs
        .list_visible_to(grouped, &groups, None, 1, 50)
        .await
        .unwrap();
    assert_eq!(
        page.iter().map(|j| j.id).collect::<HashSet<_>>(),
        HashSet::from([theirs]),
        "the SQL list agrees with the Rust gate, and lists EXACTLY their own job — a \
         `view` share reaches no other row, so this set is produced by the creator arm's \
         group disjunct and by nothing else"
    );
    assert_eq!(
        total, 1,
        "…and the TOTAL literal, which is a separate copy of the same predicate, agrees \
         exactly — this is the only coverage the group disjunct in either literal has"
    );
    assert!(
        jobs.controllable_subset(&[theirs], grouped, &groups)
            .await
            .unwrap()
            .contains(&theirs),
        "and the batched grader agrees — which is what the new `$3` group_ids \
         parameter exists for"
    );

    // NEGATIVE CONTROL 1 — the group ids ARE load-bearing: the same principal, the
    // same rows, with no active group threaded through, is refused everywhere. A
    // predicate that ignored `$2`/`$3` would pass the three admits above and fail here.
    assert_eq!(
        resolve_job_reach(&fx.pool, &job, grouped, false, &[])
            .await
            .unwrap(),
        JobReach::None,
        "negative control: without the group in hand there is no standing"
    );
    let (empty_page, empty_total) = jobs.list_visible_to(grouped, &[], None, 1, 50).await.unwrap();
    assert!(
        empty_page.is_empty() && empty_total == 0,
        "negative control: …and the list agrees"
    );
    assert_eq!(
        jobs.controllable_subset(&[theirs], grouped, &[])
            .await
            .unwrap(),
        HashSet::new(),
        "negative control: …and so does the batched grader"
    );

    // WHERE `is_active` IS ENFORCED, asserted rather than assumed — because an earlier
    // draft of this test "checked" it by deactivating the group and then re-running the
    // empty-slice call above, which is the SAME call and cannot observe the flag.
    //
    // These three predicates take an ALREADY-FILTERED group list (`$2`/`$3` are
    // `ANY(uuid[])`); none of them joins `groups`. Deactivation is enforced one layer
    // up, by `permissions::active_group_ids` at the route. So the honest assertion is
    // the surprising one: hand the predicate a DEACTIVATED group id and it still
    // admits — which is exactly why the filter must stay at the caller, and why a test
    // that "proves" revocation by passing `&[]` proves nothing.
    sqlx::query("UPDATE groups SET is_active = false WHERE id = $1")
        .bind(group)
        .execute(&fx.pool)
        .await
        .expect("deactivate");
    assert_eq!(
        resolve_job_reach(&fx.pool, &job, grouped, false, &groups)
            .await
            .unwrap(),
        JobReach::Control,
        "these predicates are CALLER-FILTERED: handed a deactivated group id they still \
         admit. `permissions::active_group_ids` is what makes deactivation a revocation \
         on the routes, and the in-SQL `groups.is_active` join exists only where the \
         predicate resolves groups ITSELF — e.g. `file_readable_by`, pinned by \
         `a_disabled_groups_member_cannot_stage_the_datasets_bytes`"
    );
    // …and the route-level filter really does drop it, so the sentence above is a
    // division of labour and not an excuse.
    let still_active = cytoanalyst::modules::permissions::active_group_ids(&[
        ziee_auth::Group {
            id: group,
            name: "shared-167".into(),
            description: None,
            permissions: vec![],
            is_system: false,
            is_active: false,
            is_default: false,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        },
    ]);
    assert!(
        still_active.is_empty(),
        "…and `active_group_ids` — the filter every one of these call sites goes \
         through — drops a deactivated group before the predicate ever sees it"
    );
}

/// TEST-21 — RESIDUE, characterized: deleting the job's SCOPE returns the removed
/// creator's reach.
///
/// `job_scope` is existence-aware, so a job whose dataset is later deleted reads as
/// SCOPE-LESS — and a scope-less job is creator-and-admin-only by design (#167 option
/// (a), DEC-3). The two rules compose into a non-monotonic closure: bob is refused
/// after his removal, and admitted again the moment a remaining member deletes the
/// dataset.
///
/// **This is not asserted because it is correct.** It is asserted because it is TRUE,
/// and because a residue that no test names is a residue the next reader will not find.
/// A read-side predicate cannot close it — an orphaned scope carries no account, so
/// refusing it would equally strip a CURRENT member's own job after an ordinary
/// cleanup, which is the over-tightening this branch exists not to commit. Closing it
/// needs #167 option (b) (`jobs.account_id`), a migration and an owner decision.
#[tokio::test]
async fn a_deleted_scope_returns_the_removed_creators_reach() {
    use cytoanalyst::modules::jobs::authz::{resolve_job_reach, JobReach};

    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;

    let bobs = seed_job(&fx.pool, fx.bob, Some(("dataset", fx.d2))).await;
    let job = load_job(&fx.pool, bobs).await;

    fx.remove_bob().await;

    assert_eq!(
        resolve_job_reach(&fx.pool, &job, fx.bob, false, &[])
            .await
            .unwrap(),
        JobReach::None,
        "the fix holds while the scope exists"
    );

    // The dataset goes away. Done as a direct row delete because the ROUTE is not the
    // point and is not even available to alice: post-#147 `DatasetRepository::delete`
    // requires `owner_id = $2 AND member`, and D2's owner is bob — so the reachable
    // production routes to this state are the platform-admin delete and an account
    // teardown, not the owner-delete handler. What the residue turns on is only that
    // the row is GONE, by any route.
    let gone = sqlx::query("DELETE FROM datasets WHERE id = $1")
        .bind(fx.d2)
        .execute(&fx.pool)
        .await
        .expect("delete the org dataset");
    assert_eq!(
        gone.rows_affected(),
        1,
        "precondition: the dataset really was there and really is gone"
    );

    assert_eq!(
        resolve_job_reach(&fx.pool, &job, fx.bob, false, &[])
            .await
            .unwrap(),
        JobReach::Control,
        "RESIDUE (#167, DEC-13): with its scope gone the job reads as scope-less, and \
         the removed creator's Control returns. Non-monotonic, requires a remaining \
         member to act, and NOT closable by a read-side predicate — an orphaned scope \
         has no account to require membership of, so refusing it would equally strip a \
         current member's own job after a routine cleanup. Needs #167 option (b)"
    );
    // The three graders still AGREE on the residue, which is the part that must not
    // regress: a job that is reachable must also be listed and stoppable, or the
    // list renders a Stop control that answers 403 (or hides one that works).
    let (page, _total) = fx
        .jobs()
        .list_visible_to(fx.bob, &[], None, 1, 50)
        .await
        .unwrap();
    assert!(
        page.iter().any(|j| j.id == bobs),
        "the SQL list agrees with the Rust gate on the residue"
    );
    assert!(
        fx.jobs()
            .controllable_subset(&[bobs], fx.bob, &[])
            .await
            .unwrap()
            .contains(&bobs),
        "and so does the batched stop grader"
    );
}

/// TEST-22 — RESIDUE, characterized: deleting the DATASET returns the removed
/// uploader's bytes.
///
/// `dataset_files.dataset_id` is `ON DELETE CASCADE` and `delete_dataset` removes the
/// links but not the `files` rows, so the file returns to "loose" and #170's
/// file-owner branch admits its uploader again. Same shape as TEST-21 and the same
/// reason it is not closed here: after the cascade there is no surviving signal that
/// the file was ever in an org dataset, so the fix has to be on the WRITE side
/// (`files.account_id` at ingest, or a re-stamp on link) — a migration and an owner
/// decision (#170 options (b)/(c)).
///
/// This is the higher-severity of the two residues, because it is CONTENT.
#[tokio::test]
async fn a_deleted_dataset_returns_the_removed_uploaders_bytes() {
    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;

    // A file bob uploaded into a SECOND org dataset he created (so deleting it does
    // not disturb the rest of the fixture).
    let f2 = seed_file(&fx.pool, fx.bob, Some(fx.d2)).await;

    fx.remove_bob().await;

    assert!(
        !file_readable_by(&fx.pool, f2, fx.bob).await.unwrap(),
        "the fix holds while the dataset exists"
    );

    // The dataset goes away. Done as a direct row delete because the ROUTE is not the
    // point and is not even available to alice: post-#147 `DatasetRepository::delete`
    // requires `owner_id = $2 AND member`, and D2's owner is bob — so the reachable
    // production routes to this state are the platform-admin delete and an account
    // teardown, not the owner-delete handler. What the residue turns on is only that
    // the row is GONE, by any route.
    let gone = sqlx::query("DELETE FROM datasets WHERE id = $1")
        .bind(fx.d2)
        .execute(&fx.pool)
        .await
        .expect("delete the org dataset");
    assert_eq!(
        gone.rows_affected(),
        1,
        "precondition: the dataset really was there and really is gone"
    );

    assert!(
        file_readable_by(&fx.pool, f2, fx.bob).await.unwrap(),
        "RESIDUE (#170, DEC-13): the delete cascades the `dataset_files` link away but \
         leaves the `files` row, so the file is 'loose' again and its uploader's \
         sandbox stages the BYTES. Non-monotonic and not closable on the read side — \
         nothing survives the cascade to say the file was ever in an org dataset. \
         Needs #170 option (b)/(c), a write-side stamp"
    );
    // …and the rest of the predicate is unaffected: bob's file in the SURVIVING org
    // dataset D is still refused, so the residue is exactly the deleted-dataset case.
    assert!(
        !file_readable_by(&fx.pool, fx.f, fx.bob).await.unwrap(),
        "control: the file in the dataset that still exists is still refused"
    );
}

/// TEST-23 — the `is_admin` disjunct in the JOBS sync audience.
///
/// Gating the creator arm of `visible_to_user_ids` (#167 × #168) would have dropped one
/// recipient who can demonstrably still read the row: a platform admin who STARTED a job
/// against a tenant's dataset has no membership and no share there, so they fail the
/// standing conjunct — while `resolve_job_reach` hands them `Control` on its first line.
/// A recipient removed who can still open and STOP the job is the mirror-image of the
/// leak the branch is closing, so the disjunct exists; this is the only thing that pins
/// it (every other job in this suite is owned by alice, bob or dana, none of them admin).
#[tokio::test]
async fn the_job_creating_platform_admin_stays_in_its_audience() {
    use cytoanalyst::modules::jobs::authz::{resolve_job_reach, JobReach};

    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;

    let admin_id: Uuid = sqlx::query_scalar("SELECT id FROM users WHERE is_admin = true LIMIT 1")
        .fetch_one(&fx.pool)
        .await
        .expect("the platform admin user");
    assert_ne!(admin_id, fx.alice, "sanity: the admin is not one of the members");

    // The admin starts a job on the ORG's dataset. They are not a member of that
    // account and hold no share on D, so they have NO standing on the scope.
    let admins = seed_job(&fx.pool, admin_id, Some(("dataset", fx.d))).await;
    let job = load_job(&fx.pool, admins).await;
    assert!(
        !sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM account_members WHERE account_id = $1 AND user_id = $2)"
        )
        .bind(fx.org)
        .bind(admin_id)
        .fetch_one(&fx.pool)
        .await
        .unwrap(),
        "precondition: the admin has NO membership of the dataset's account — otherwise \
         the membership arm would admit them and this test would prove nothing"
    );

    assert_eq!(
        resolve_job_reach(&fx.pool, &job, admin_id, true, &[])
            .await
            .unwrap(),
        JobReach::Control,
        "precondition: the gate admits them (the admin short-circuit), so being absent \
         from the audience would mean they can open and STOP a job nobody tells them about"
    );

    let (anchor, others) = JobRepository::visible_to_user_ids(&fx.pool, admins)
        .await
        .unwrap()
        .expect("the job has an audience");
    let audience: HashSet<Uuid> = others.into_iter().chain([anchor]).collect();
    assert!(
        audience.contains(&admin_id),
        "the job-creating platform admin is in its audience — this is the `is_admin` \
         disjunct, and nothing else in the suite reaches it"
    );

    // NEGATIVE CONTROL — the disjunct is scoped to `users.is_admin`, not opened to
    // every creator. bob, a NON-admin with no standing after removal, is excluded from
    // the audience of the job HE created on the same dataset.
    let bobs = seed_job(&fx.pool, fx.bob, Some(("dataset", fx.d))).await;
    fx.remove_bob().await;
    let (banchor, bothers) = JobRepository::visible_to_user_ids(&fx.pool, bobs)
        .await
        .unwrap()
        .expect("audience");
    let baudience: HashSet<Uuid> = bothers.into_iter().chain([banchor]).collect();
    assert!(
        !baudience.contains(&fx.bob),
        "negative control: a NON-admin creator with no standing is still excluded — the \
         disjunct tests `users.is_admin`, it does not re-open the creator arm"
    );
}

/// TEST-24 — the three dataset routes whose audience must be captured AROUND their
/// mutation: `share`, `unshare` and `split`.
///
/// They cannot use `publish_dataset_audience` (the audience has to outlive, or postdate,
/// the write), so the rename/upload legs of TEST-18 do not cover them. Each switched
/// from `auth.user.id ∪ sharee_user_ids` to `dataset_audience`, and the principal that
/// makes the switch observable is ALICE: the account owner, neither the actor nor a
/// sharee, who could open the dataset the whole time and was told nothing.
#[tokio::test]
async fn the_share_unshare_and_split_routes_fan_to_the_account_audience() {
    use crate::common::sync_probe::SyncProbe;
    use std::time::Duration;

    let server = TestServer::spawn().await;
    let fx = Fixture::build(&server).await;
    let dana_token = super::login(&server, "dana").await;
    let alice_token = super::login(&server, "alice").await;
    let mut alice_probe = SyncProbe::open(&server, &alice_token).await;

    // SHARE — resolved AFTER the write, so the newly-added principal is in the set.
    let shared = server
        .client
        .post(server.api_url(&format!("/datasets/{}/shares", fx.e)))
        .bearer_auth(&dana_token)
        .json(&serde_json::json!({
            "principal_type": "user", "principal_id": fx.eve, "role": "view"
        }))
        .send()
        .await
        .expect("share dataset");
    assert_eq!(shared.status().as_u16(), 201, "precondition: dana shares her dataset");
    let share_id = shared.json::<serde_json::Value>().await.expect("json")["id"]
        .as_str()
        .expect("share id")
        .to_string();
    alice_probe
        .expect_event_for("dataset", "update", &fx.e.to_string(), Duration::from_secs(5))
        .await;

    // UNSHARE — resolved BEFORE the write, so the ex-sharee is still told to refetch.
    let unshared = server
        .client
        .delete(server.api_url(&format!("/datasets/{}/shares/{share_id}", fx.e)))
        .bearer_auth(&dana_token)
        .send()
        .await
        .expect("unshare dataset");
    assert_eq!(unshared.status().as_u16(), 204, "precondition: dana unshares it");
    alice_probe
        .expect_event_for("dataset", "update", &fx.e.to_string(), Duration::from_secs(5))
        .await;

    // SPLIT — resolved BEFORE the parent delete (its shares cascade), and the children's
    // Create now goes to the child's audience rather than to the actor alone, so the
    // account owner does not watch the parent vanish and the children never appear.
    let multi: Uuid = sqlx::query_scalar(
        "INSERT INTO datasets (id, owner_id, account_id, name, metadata) \
         VALUES (randomblob(16), $1, $2, 'danas-multi', '{}') RETURNING id",
    )
    .bind(fx.dana)
    .bind(fx.org)
    .fetch_one(&fx.pool)
    .await
    .expect("seed a multi-file dataset");
    for i in 0..2i32 {
        let f = seed_file(&fx.pool, fx.dana, None).await;
        sqlx::query(
            "INSERT INTO dataset_files (dataset_id, file_id, ordinal, role) \
             VALUES ($1, $2, $3, 'primary')",
        )
        .bind(multi)
        .bind(f)
        .bind(i)
        .execute(&fx.pool)
        .await
        .expect("link file");
    }
    let split = server
        .client
        .post(server.api_url(&format!("/datasets/{multi}/split")))
        .bearer_auth(&dana_token)
        .send()
        .await
        .expect("split dataset");
    assert_eq!(
        split.status().as_u16(),
        200,
        "precondition: a two-file dataset splits"
    );
    let children: Vec<String> = split.json::<serde_json::Value>().await.expect("json")["datasets"]
        .as_array()
        .expect("datasets")
        .iter()
        // `DatasetWithFiles` flattens the dataset, so the child's id is at the top level.
        .map(|d| d["id"].as_str().expect("child id").to_string())
        .collect();
    assert_eq!(children.len(), 2, "precondition: two children");

    // Order matters here, and it is the emit order, not a preference: the handler
    // publishes each child's Create inside the loop and the parent's Delete after it,
    // and `expect_event_for` DISCARDS every frame it passes over while searching. Waiting
    // for the Delete first would therefore consume the Creates and then time out on them.
    for child in &children {
        alice_probe
            .expect_event_for("dataset", "create", child, Duration::from_secs(5))
            .await;
    }
    alice_probe
        .expect_event_for("dataset", "delete", &multi.to_string(), Duration::from_secs(5))
        .await;
}
