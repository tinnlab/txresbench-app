//! A3 authz-flip scope tests (TEST-3/4/5) — the flipped read/access predicates
//! resolve by ACCOUNT MEMBERSHIP, preserving the orthogonal share unions, and 404 a
//! non-member. Exercised at the repository/resolver layer (the exact functions A3
//! flipped) against a real per-test DB, with a synthetic two-member ORG account.

use cytoanalyst::modules::dataset::repository::{DatasetAccess, DatasetRepository};
use cytoanalyst::modules::jobs::authz::{resolve_job_reach, JobReach};
use cytoanalyst::modules::jobs::models::Job;
use cytoanalyst::modules::project::{EffectivePermission, ProjectRepository};
use cytoanalyst::modules::workstore::authz::{
    require_artifact_read, require_dataset_read, require_project_read,
};
use cytoanalyst::modules::workstore::catalog::{Artifact, CatalogRepository, NewArtifact};

use super::{
    add_member, create_user, make_org_account, move_dataset_to_account, move_project_to_account,
    pool_for, setup_admin,
};
use crate::common::TestServer;

// A3 TEST-3 [ITEM-2]: `list_visible` widens to account membership (a co-member sees a
// project owned by another member), still excludes a non-member's account, and keeps
// the accepted-share union.
#[tokio::test]
async fn list_visible_widens_to_account_membership_keeps_share_union() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let alice = create_user(&server, &admin, "alice", "alice@x.test").await;
    let bob = create_user(&server, &admin, "bob", "bob@x.test").await;
    let carol = create_user(&server, &admin, "carol", "carol@x.test").await;
    let pool = pool_for(&server).await;
    let projects = ProjectRepository::new(pool.clone());

    // Org account { alice=owner, bob=member }; carol is NOT a member.
    let org = make_org_account(&pool, "Lab", alice).await;
    add_member(&pool, org, bob, "member").await;

    // A project owned by alice, living in the ORG account.
    let p_org = projects.create(alice, "org-project", "").await.unwrap();
    move_project_to_account(&pool, p_org.id, org).await;
    // A project owned by alice in her PERSONAL account (bob is not a member of it).
    let p_personal = projects
        .create(alice, "personal-project", "")
        .await
        .unwrap();

    // bob (co-member) sees the ORG project but NOT alice's personal project.
    let (bob_list, _n) = projects.list_visible(bob, None, 1, 50).await.unwrap();
    let bob_ids: Vec<_> = bob_list.iter().map(|p| p.id).collect();
    assert!(
        bob_ids.contains(&p_org.id),
        "co-member sees the org project"
    );
    assert!(
        !bob_ids.contains(&p_personal.id),
        "co-member does NOT see a project in an account they are not a member of"
    );
    // bob's effective permission on the widened row is the Viewer floor (a bare member).
    let row = bob_list.iter().find(|p| p.id == p_org.id).unwrap();
    assert_eq!(
        row.effective_permission, "viewer",
        "bare member → Viewer floor"
    );

    // carol (non-member) sees neither.
    let (carol_list, _n) = projects.list_visible(carol, None, 1, 50).await.unwrap();
    assert!(
        carol_list
            .iter()
            .all(|p| p.id != p_org.id && p.id != p_personal.id),
        "a non-member sees no cross-account project"
    );

    // The accepted-share union still returns a shared project to carol.
    let shared = projects.create(alice, "shared", "").await.unwrap();
    sqlx::query(
        "INSERT INTO project_shares (id, project_id, owner_id, recipient_id, permission_level, status) \
         VALUES (randomblob(16), $1, $2, $3, 'viewer', 'accepted')",
    )
    .bind(shared.id)
    .bind(alice)
    .bind(carol)
    .execute(&pool)
    .await
    .unwrap();
    let (carol_list2, _n) = projects.list_visible(carol, None, 1, 50).await.unwrap();
    assert!(
        carol_list2.iter().any(|p| p.id == shared.id),
        "accepted-share union preserved"
    );
}

// A3 TEST-4 [ITEM-3]: dataset read/edit access resolves via account membership; the
// share union is preserved; a bare member is read-only, an account admin can edit.
#[tokio::test]
async fn dataset_access_resolves_via_account_membership() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let alice = create_user(&server, &admin, "alice", "alice@x.test").await;
    let bob = create_user(&server, &admin, "bob", "bob@x.test").await;
    let dana = create_user(&server, &admin, "dana", "dana@x.test").await;
    let carol = create_user(&server, &admin, "carol", "carol@x.test").await;
    let pool = pool_for(&server).await;
    let datasets = DatasetRepository::new(pool.clone());

    let org = make_org_account(&pool, "Lab", alice).await;
    add_member(&pool, org, bob, "member").await;
    add_member(&pool, org, dana, "admin").await;

    let ds = datasets
        .create(alice, "org-ds", None, &serde_json::json!({}))
        .await
        .unwrap();
    move_dataset_to_account(&pool, ds.id, org).await;

    // co-member (bob) can READ but NOT edit (Viewer floor).
    assert!(
        datasets.is_visible_to(ds.id, bob, &[]).await.unwrap(),
        "co-member reads"
    );
    assert_eq!(
        datasets.access(ds.id, bob, &[]).await.unwrap(),
        DatasetAccess::ViewOnly
    );
    // account ADMIN (dana) can EDIT.
    assert_eq!(
        datasets.access(ds.id, dana, &[]).await.unwrap(),
        DatasetAccess::CanEdit
    );
    assert!(datasets.require_can_edit(ds.id, dana, &[]).await.is_ok());
    // editable_subset stays in lock-step: admin edits, bare member does not.
    let editable = datasets.editable_subset(&[ds.id], dana, &[]).await.unwrap();
    assert!(editable.contains(&ds.id));
    let editable_bob = datasets.editable_subset(&[ds.id], bob, &[]).await.unwrap();
    assert!(
        !editable_bob.contains(&ds.id),
        "a bare member is not an editor"
    );
    // non-member (carol) → not visible.
    assert!(
        !datasets.is_visible_to(ds.id, carol, &[]).await.unwrap(),
        "non-member not visible"
    );
    assert_eq!(
        datasets.access(ds.id, carol, &[]).await.unwrap(),
        DatasetAccess::NotVisible
    );
}

// A3 TEST-5 [ITEM-4/5/6]: the workstore project/dataset gates admit a co-member and
// 404 a non-member; `resolve_job_reach` reaches a member of the job's project's
// account; a sandbox dataset-file ref to a cross-account file is refused.
#[tokio::test]
async fn workstore_and_job_and_sandbox_gates_are_account_aware() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let alice = create_user(&server, &admin, "alice", "alice@x.test").await;
    let bob = create_user(&server, &admin, "bob", "bob@x.test").await;
    let dana = create_user(&server, &admin, "dana", "dana@x.test").await;
    let carol = create_user(&server, &admin, "carol", "carol@x.test").await;
    let pool = pool_for(&server).await;
    let projects = ProjectRepository::new(pool.clone());
    let datasets = DatasetRepository::new(pool.clone());

    let org = make_org_account(&pool, "Lab", alice).await;
    add_member(&pool, org, bob, "member").await;
    add_member(&pool, org, dana, "admin").await;

    let p = projects.create(alice, "wp", "").await.unwrap();
    move_project_to_account(&pool, p.id, org).await;
    let ds = datasets
        .create(alice, "wd", None, &serde_json::json!({}))
        .await
        .unwrap();
    move_dataset_to_account(&pool, ds.id, org).await;

    // require_project_read / require_dataset_read: co-member OK, non-member 404.
    assert!(
        require_project_read(&pool, p.id, bob).await.is_ok(),
        "co-member reads project"
    );
    let e = require_project_read(&pool, p.id, carol).await.unwrap_err();
    assert_eq!(e.0.as_u16(), 404, "non-member → 404 (no leak)");
    assert!(
        require_dataset_read(&pool, ds.id, bob).await.is_ok(),
        "co-member reads dataset"
    );
    let e = require_dataset_read(&pool, ds.id, carol).await.unwrap_err();
    assert_eq!(e.0.as_u16(), 404, "non-member dataset → 404");

    // resolve_job_reach: a job owned by a THIRD user (alice), project-scoped to the
    // org project, is reachable by the account members at their graded role, and NOT
    // by a non-member — reach is by account, not launcher.
    let job_id = uuid::Uuid::new_v4();
    sqlx::query(
        "INSERT INTO jobs (id, owner_id, job_type, name, status, params, created_at, \
                           priority_class, resource_class) \
         VALUES ($1, $2, 'stub', 'j', 'running', '{}', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'normal', 'cpu-sandbox')",
    )
    .bind(job_id)
    .bind(alice)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO job_scope (job_id, scope_kind, scope_id) VALUES ($1, 'project', $2)")
        .bind(job_id)
        .bind(p.id)
        .execute(&pool)
        .await
        .unwrap();
    let job: Job = sqlx::query_as("SELECT * FROM jobs WHERE id = $1")
        .bind(job_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    // account owner (alice is also the job owner here → Control); use dana (admin,
    // NOT the job owner) to prove the account rung, not the creator short-circuit.
    let dana_reach = resolve_job_reach(&pool, &job, dana, false, &[])
        .await
        .unwrap();
    assert!(
        dana_reach.can_see(),
        "an account admin reaches the job by membership"
    );
    let carol_reach = resolve_job_reach(&pool, &job, carol, false, &[])
        .await
        .unwrap();
    assert_eq!(
        carol_reach,
        JobReach::None,
        "a non-member does not reach the job"
    );

    // Effective permission grades: dana(admin)→Editor, bob(member)→Viewer.
    assert_eq!(
        projects.effective_permission(p.id, dana).await.unwrap(),
        Some(EffectivePermission::Editor)
    );
    assert_eq!(
        projects.effective_permission(p.id, bob).await.unwrap(),
        Some(EffectivePermission::Viewer)
    );

    // Sandbox (ITEM-6): the sandbox authorizes every artifact input ref through
    // `workstore::authz::require_artifact_read` (sandbox/inputs.rs:590), which
    // dispatches to the now-account-aware project/dataset gate. A project-scoped
    // artifact in the org account is admitted for a co-member and 404'd for a
    // non-member — proving the sandbox cannot reach a cross-account artifact.
    let artifact = seed_project_artifact(&pool, p.id).await;
    assert!(
        require_artifact_read(&pool, &artifact, bob).await.is_ok(),
        "a co-member's sandbox may read a project artifact in the shared account"
    );
    let e = require_artifact_read(&pool, &artifact, carol)
        .await
        .unwrap_err();
    assert_eq!(
        e.0.as_u16(),
        404,
        "a cross-account artifact is refused (ITEM-6 transitive deny)"
    );
}

/// Insert a minimal project-scoped artifact via the real catalog repository and
/// return the `Artifact` value `require_artifact_read` dispatches on (only its
/// `project_id`/`dataset_id` scope is read). `object_key` present satisfies the
/// bytes-or-recipe CHECK.
async fn seed_project_artifact(pool: &sqlx::SqlitePool, project_id: uuid::Uuid) -> Artifact {
    let catalog = CatalogRepository::new(pool.clone());
    catalog
        .insert_artifact(&NewArtifact {
            project_id: Some(project_id),
            dataset_id: None,
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
        .expect("insert artifact")
}
