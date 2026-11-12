//! A3 TEST-8 [acceptance, INV-3] — authz scopes by `account_id ∈ memberships`, NEVER
//! by `owner_id = user_id`. A project owned by member X in a two-member account A is
//! reachable by member Y who does NOT own it; a job's reach is the account's members,
//! not the launcher alone.

use txresbench::modules::jobs::authz::{resolve_job_reach, JobReach};
use txresbench::modules::jobs::models::Job;
use txresbench::modules::project::scope::ProjectScope;
use txresbench::modules::project::{EffectivePermission, ProjectRepository};

use super::{
    add_member, create_user, make_org_account, move_project_to_account, pool_for, setup_admin,
};
use crate::common::TestServer;

#[tokio::test]
async fn reach_is_by_account_id_not_owner_id() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let x = create_user(&server, &admin, "xowner", "x@x.test").await;
    let y = create_user(&server, &admin, "ymember", "y@x.test").await;
    let z = create_user(&server, &admin, "zoutsider", "z@x.test").await;
    let pool = pool_for(&server).await;
    let projects = ProjectRepository::new(pool.clone());

    // Two-member org { x=owner, y=admin }; z is not a member.
    let org = make_org_account(&pool, "Lab", x).await;
    add_member(&pool, org, y, "admin").await;

    // A project OWNED by x, living in the shared account.
    let p = projects.create(x, "shared-atlas", "").await.unwrap();
    move_project_to_account(&pool, p.id, org).await;

    // Y (NOT the owner) reaches the project purely by account membership.
    let y_scope = ProjectScope::resolve_in_account(&projects, p.id, y)
        .await
        .unwrap();
    assert!(
        y_scope.is_some(),
        "co-member Y reaches a project they do NOT own"
    );
    assert_ne!(p.owner_id, y, "Y is genuinely not the owner_id");
    // Y is an account admin → graded to Editor (can edit the account's project).
    assert_eq!(y_scope.unwrap().perm, EffectivePermission::Editor);

    // Z (non-member) does NOT reach it → None (⇒404), never the row.
    assert!(
        ProjectScope::resolve_in_account(&projects, p.id, z)
            .await
            .unwrap()
            .is_none(),
        "a non-member does NOT reach the project (cross-account 404)"
    );

    // A job launched by X, project-scoped to the shared project, is reachable by Y —
    // the account's member — not only by the launcher X.
    let job_id = uuid::Uuid::new_v4();
    sqlx::query(
        "INSERT INTO jobs (id, owner_id, job_type, name, status, params, created_at, \
                           priority_class, resource_class) \
         VALUES ($1, $2, 'stub', 'j', 'running', '{}', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'normal', 'cpu-sandbox')",
    )
    .bind(job_id)
    .bind(x)
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
    let y_reach = resolve_job_reach(&pool, &job, y, false, &[]).await.unwrap();
    assert!(
        y_reach.can_see(),
        "the account member Y reaches the launcher X's job (reach is by account, not launcher)"
    );
    let z_reach = resolve_job_reach(&pool, &job, z, false, &[]).await.unwrap();
    assert_eq!(
        z_reach,
        JobReach::None,
        "a non-member does not reach the job"
    );
}
