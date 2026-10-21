//! T5 — compute + storage metering (account_id-keyed, exactly-once). The acceptance +
//! contract tests for the raw metering signal billing's usage-rollup (B1) consumes
//! (PROV-compute-metering-1). Shared helpers here; the invariant tests in the submodules.

use chrono::Utc;
use serde_json::{json, Value};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use uuid::Uuid;

use cytoanalyst::modules::jobs::models::Job;

use crate::common::TestServer;

mod account_key_test;
mod saas_gating_test;
mod schema_contract_test;

/// Register the first admin and return its bearer token (also creates the admin's
/// personal account — the baseline every downstream account differs from).
pub(crate) async fn setup_admin(server: &TestServer) -> String {
    let resp = server
        .client
        .post(server.api_url("/app/setup/admin"))
        .json(&json!({
            "username": "admin", "email": "admin@cyto.test",
            "password": "adminPassw0rd!", "display_name": "Admin"
        }))
        .send()
        .await
        .expect("setup/admin");
    assert_eq!(resp.status().as_u16(), 201);
    let body: Value = resp.json().await.expect("setup json");
    body["access_token"]
        .as_str()
        .or_else(|| body["token"].as_str())
        .expect("token")
        .to_string()
}

/// Create a project through the REST API (lands in the caller's personal account).
pub(crate) async fn create_project(server: &TestServer, token: &str, name: &str) -> Uuid {
    let r = server
        .client
        .post(server.api_url("/projects"))
        .bearer_auth(token)
        .json(&json!({ "name": name, "description": "" }))
        .send()
        .await
        .expect("create project");
    assert_eq!(r.status().as_u16(), 201, "create project");
    let s: Value = r.json().await.expect("project json");
    Uuid::parse_str(s["id"].as_str().expect("project id")).unwrap()
}

pub(crate) async fn pool_for(server: &TestServer) -> PgPool {
    PgPoolOptions::new()
        .max_connections(4)
        .connect(server.database_url())
        .await
        .expect("connect test pool")
}

/// Insert a standalone ORGANIZATION account and return its id (distinct from any
/// personal account — the tenant a project can be re-parented to for the INV-2 proof).
pub(crate) async fn insert_org_account(pool: &PgPool, name: &str) -> Uuid {
    sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO accounts (kind, name) VALUES ('organization', $1) RETURNING id",
    )
    .bind(name)
    .fetch_one(pool)
    .await
    .expect("insert org account")
}

/// The account a project currently belongs to (read straight off the column).
pub(crate) async fn project_account(pool: &PgPool, project_id: Uuid) -> Uuid {
    sqlx::query_scalar::<_, Uuid>("SELECT account_id FROM projects WHERE id = $1")
        .bind(project_id)
        .fetch_one(pool)
        .await
        .expect("project account_id")
}

/// Re-parent a project onto a different account (models a project whose account moved).
pub(crate) async fn set_project_account(pool: &PgPool, project_id: Uuid, account_id: Uuid) {
    sqlx::query("UPDATE projects SET account_id = $1 WHERE id = $2")
        .bind(account_id)
        .bind(project_id)
        .execute(pool)
        .await
        .expect("repoint project account");
}

/// Insert a real `jobs` row (the `job_scope` FK requires it) owned by `owner_id` (a real
/// user, since `jobs.owner_id → users`). Mirrors the in-memory `Job` so the finalize path
/// sees a consistent row.
pub(crate) async fn insert_job(pool: &PgPool, job: &Job, owner_id: Uuid) {
    sqlx::query(
        "INSERT INTO jobs (id, owner_id, job_type, name, status, resource_class, started_at, \
         finished_at, exit_code) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(job.id)
    .bind(owner_id)
    .bind(&job.job_type)
    .bind(&job.name)
    .bind(&job.status)
    .bind(&job.resource_class)
    .bind(job.started_at)
    .bind(job.finished_at)
    .bind(job.exit_code)
    .execute(pool)
    .await
    .expect("insert jobs row");
}

/// Link a job to a project scope so `job_scope` resolves it (the mapping T5 reads to
/// derive `account_of(project)` at finalize).
pub(crate) async fn scope_job_to_project(pool: &PgPool, job_id: Uuid, project_id: Uuid) {
    sqlx::query("INSERT INTO job_scope (job_id, scope_kind, scope_id) VALUES ($1, 'project', $2)")
        .bind(job_id)
        .bind(project_id)
        .execute(pool)
        .await
        .expect("scope job to project");
}

/// Link a job to a dataset scope.
pub(crate) async fn scope_job_to_dataset(pool: &PgPool, job_id: Uuid, dataset_id: Uuid) {
    sqlx::query("INSERT INTO job_scope (job_id, scope_kind, scope_id) VALUES ($1, 'dataset', $2)")
        .bind(job_id)
        .bind(dataset_id)
        .execute(pool)
        .await
        .expect("scope job to dataset");
}

/// Insert a dataset owned by `owner_id` under `account_id` and return its id.
pub(crate) async fn insert_dataset(pool: &PgPool, owner_id: Uuid, account_id: Uuid) -> Uuid {
    sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO datasets (id, name, owner_id, account_id) \
         VALUES (gen_random_uuid(), 't5-dataset', $1, $2) RETURNING id",
    )
    .bind(owner_id)
    .bind(account_id)
    .fetch_one(pool)
    .await
    .expect("insert dataset")
}

/// The owner (a real user) of a project — used as a valid `owner_id` for a dataset insert.
pub(crate) async fn project_owner(pool: &PgPool, project_id: Uuid) -> Uuid {
    sqlx::query_scalar::<_, Uuid>("SELECT owner_id FROM projects WHERE id = $1")
        .bind(project_id)
        .fetch_one(pool)
        .await
        .expect("project owner_id")
}

/// A finished (`completed`) job with a fresh id and the given exit code.
pub(crate) fn finished_job(exit_code: i32) -> Job {
    Job {
        id: Uuid::new_v4(),
        owner_id: Uuid::new_v4(),
        job_type: "analysis".into(),
        name: "t5-metering".into(),
        status: if exit_code == 0 {
            "completed"
        } else {
            "failed"
        }
        .into(),
        params: json!({}),
        created_at: Utc::now(),
        started_at: Some(Utc::now()),
        finished_at: Some(Utc::now()),
        exit_code: Some(exit_code),
        error: None,
        pid: None,
        priority_class: "normal".into(),
        resource_class: "cpu-sandbox".into(),
        req_cpu: None,
        req_mem_bytes: None,
        run_id: None,
    }
}

/// Count `compute_meter` rows for a job (the exactly-once observable).
pub(crate) async fn compute_meter_count(pool: &PgPool, job_id: Uuid) -> i64 {
    sqlx::query_scalar::<_, i64>("SELECT count(*)::bigint FROM compute_meter WHERE job_id = $1")
        .bind(job_id)
        .fetch_one(pool)
        .await
        .expect("count compute_meter")
}

/// The `account_id` a job's `compute_meter` row landed on.
pub(crate) async fn compute_meter_account(pool: &PgPool, job_id: Uuid) -> Option<Uuid> {
    sqlx::query_scalar::<_, Option<Uuid>>("SELECT account_id FROM compute_meter WHERE job_id = $1")
        .bind(job_id)
        .fetch_one(pool)
        .await
        .expect("compute_meter account_id")
}
