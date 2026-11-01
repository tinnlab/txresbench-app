//! Provenance module integration tests (P4 · TEST-16..27) — the full production
//! path through a real spawned server + real Postgres (per-test DB) + a real
//! content-addressed object store on disk.
//!
//! Seeding: P4's graph facade rides P1's `workstore` catalog, which has no
//! artifact-CREATE HTTP endpoint, so a "root" input artifact is seeded via the
//! lib's own `CatalogRepository` against the server's per-test DB pool (mirrors
//! `tests/workstore/`). Reference-resource roots are seeded via the provenance
//! repository. Everything else drives the real REST surface.

use serde_json::{json, Value};
use sqlx::sqlite::SqlitePoolOptions;
use sqlx::SqlitePool;
use uuid::Uuid;

use cytoanalyst::modules::workstore::catalog::models::NewArtifact;
use cytoanalyst::modules::workstore::catalog::repository::CatalogRepository;

use crate::common::TestServer;

// ------------------------------- auth helpers -------------------------------

/// First-run setup → the admin owner + their access token (holds the `*`
/// wildcard, so every provenance perm incl. `settings::{read,manage}`).
async fn setup_admin(server: &TestServer) -> String {
    let resp = server
        .client
        .post(server.api_url("/session/local"))
        .json(&json!({
            "username": "admin",
            "email": "admin@cyto.test",
            "password": "adminPassw0rd!",
            "display_name": "Admin"
        }))
        .send()
        .await
        .expect("setup/admin");
    assert_eq!(resp.status().as_u16(), 200, "setup/admin creates the owner");
    token_of(resp.json().await.expect("setup json"))
}

fn token_of(body: Value) -> String {
    body["access_token"]
        .as_str()
        .or_else(|| body["token"].as_str())
        .expect("token in response")
        .to_string()
}

/// Create a user (admin) — auto-joined to the Users group, so they hold
/// `projects::use` + `provenance::{read,export}`. Returns the id.
async fn create_user(server: &TestServer, admin: &str, username: &str, email: &str) -> String {
    let resp = server
        .client
        .post(server.api_url("/auth/register"))
        .bearer_auth(admin)
        .json(&json!({
            "username": username,
            "email": email,
            "password": "userPassw0rd!",
        }))
        .send()
        .await
        .expect("create user");
    assert!(resp.status().is_success(), "create user {username}: {}", resp.status());
    let body: Value = resp.json().await.expect("user json");
    body["user"]["id"].as_str().expect("user id").to_string()
}

/// Log in → an access token.
async fn login(server: &TestServer, username: &str) -> String {
    let resp = server
        .client
        .post(server.api_url("/auth/login"))
        .json(&json!({ "username": username, "password": "userPassw0rd!" }))
        .send()
        .await
        .expect("login");
    assert_eq!(resp.status().as_u16(), 200, "login {username}");
    token_of(resp.json().await.expect("login json"))
}

/// Create a user then STRIP them from the Users group → they no longer hold
/// `provenance::read`/`export` (the A9 deny path). Returns their token.
async fn create_user_without_provenance(
    server: &TestServer,
    admin: &str,
    username: &str,
    email: &str,
) -> String {
    let id = create_user(server, admin, username, email).await;
    // The `/groups` HTTP surface is stripped on this node; the removal goes
    // through the SDK user repository over the per-test DB pool.
    let pool = pool_for(server).await;
    crate::common::group_remove_from_users(
        &pool,
        Uuid::parse_str(&id).expect("user id is a uuid"),
    )
    .await;
    login(server, username).await
}

// ------------------------------ project helpers ------------------------------

/// Create a project → its id.
async fn create_project(server: &TestServer, token: &str, name: &str) -> Uuid {
    let resp = server
        .client
        .post(server.api_url("/projects"))
        .bearer_auth(token)
        .json(&json!({ "name": name, "description": "" }))
        .send()
        .await
        .expect("create project");
    assert_eq!(resp.status().as_u16(), 201, "create project {name}");
    let body: Value = resp.json().await.expect("project json");
    Uuid::parse_str(body["id"].as_str().expect("project id")).unwrap()
}

/// A pool against the spawned server's per-test DB (for direct catalog/provenance
/// seeding the REST surface has no endpoint for).
async fn pool_for(server: &TestServer) -> SqlitePool {
    SqlitePoolOptions::new()
        .max_connections(2)
        .connect(server.database_url())
        .await
        .expect("connect test pool")
}

/// Seed a ROOT input artifact (run_id NULL — a source/upload root) into P1's
/// catalog. Returns its id. `content_hash` becomes the pinned closure terminus.
async fn seed_root_artifact(pool: &SqlitePool, project_id: Uuid, content_hash: &str) -> Uuid {
    let catalog = CatalogRepository::new(pool.clone());
    let art = catalog
        .insert_artifact(&NewArtifact {
            project_id: Some(project_id), // ITEM-23: project/dataset scope now nullable
            dataset_id: None,
            run_id: None, // root: no producing run → the backward walk stops here
            output_id: "upload".to_string(),
            datatype: "single-cell/expression".to_string(),
            object_key: Some(content_hash.to_string()),
            is_multifile: false,
            content_hash: content_hash.to_string(),
            structure: serde_json::json!({ "encoding": "opaque", "media_type": "application/octet-stream" }),
            meta: serde_json::json!({}),
            role: "artifact".to_string(),
            stored_bytes: 0,
            logical_bytes: Some(0),
            created_by: None,
            hidden: false,
            representation_of: None,
        })
        .await
        .expect("seed root artifact");
    art.id
}

/// Seed a DATASET-scoped root artifact (`project_id` NULL, `dataset_id` set) — what an
/// upload actually produces, and the shape a workbench run over an attached dataset
/// consumes. Distinct from [`seed_root_artifact`], which seeds the project-scoped shape.
async fn seed_dataset_scoped_artifact(
    pool: &SqlitePool,
    dataset_id: Uuid,
    content_hash: &str,
) -> Uuid {
    let catalog = CatalogRepository::new(pool.clone());
    let art = catalog
        .insert_artifact(&NewArtifact {
            project_id: None,
            dataset_id: Some(dataset_id),
            run_id: None,
            output_id: "expression".to_string(),
            datatype: "single-cell/expression".to_string(),
            object_key: Some(content_hash.to_string()),
            is_multifile: false,
            content_hash: content_hash.to_string(),
            structure: serde_json::json!({ "encoding": "opaque", "media_type": "application/octet-stream" }),
            meta: serde_json::json!({}),
            role: "artifact".to_string(),
            stored_bytes: 0,
            logical_bytes: Some(0),
            created_by: None,
            hidden: false,
            representation_of: None,
        })
        .await
        .expect("seed dataset-scoped artifact");
    art.id
}

/// Create a project + seed a hashed root input artifact. Returns
/// `(project_id, root_artifact_id, root_content_hash)`.
async fn create_project_with_artifact(
    server: &TestServer,
    token: &str,
    name: &str,
) -> (Uuid, Uuid, String) {
    let project_id = create_project(server, token, name).await;
    let content_hash = format!("sha256:{}", "a".repeat(64));
    let pool = pool_for(server).await;
    let art_id = seed_root_artifact(&pool, project_id, &content_hash).await;
    (project_id, art_id, content_hash)
}

/// Share `project_id` with a freshly created user at `permission_level` and have them
/// accept it → their access token.
async fn shared_collaborator(
    server: &TestServer,
    admin: &str,
    project_id: Uuid,
    username: &str,
    level: &str,
) -> String {
    let email = format!("{username}@cyto.test");
    create_user(server, admin, username, &email).await;
    let token = login(server, username).await;
    let share = server
        .client
        .post(server.api_url(&format!("/projects/{project_id}/shares")))
        .bearer_auth(admin)
        .json(&json!({ "email": email, "permission_level": level }))
        .send()
        .await
        .expect("share project");
    assert!(share.status().is_success(), "share: {}", share.status());
    let share_id = share.json::<Value>().await.expect("share json")["id"]
        .as_str()
        .expect("share id")
        .to_string();
    let acc = server
        .client
        .post(server.api_url(&format!("/project-shares/{share_id}/accept")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("accept share");
    assert!(acc.status().is_success(), "accept share: {}", acc.status());
    token
}

/// A `selection.column` recipe (a deterministic predicate that emits code).
fn column_recipe(val: &str) -> Value {
    json!({ "kind": "column", "col": "leiden", "op": "==", "val": val })
}

/// `POST /provenance/selections` → the created run node JSON. Asserts 201.
async fn record_selection(
    server: &TestServer,
    token: &str,
    project_id: Uuid,
    input_artifact_id: Uuid,
    recipe: Value,
) -> Value {
    let resp = server
        .client
        .post(server.api_url("/provenance/selections"))
        .bearer_auth(token)
        .json(&json!({
            "project_id": project_id,
            "input_artifact_id": input_artifact_id,
            "recipe": recipe,
            "label": "test selection",
        }))
        .send()
        .await
        .expect("record selection");
    assert_eq!(resp.status().as_u16(), 201, "record selection is 201");
    resp.json().await.expect("run node json")
}

// --------------------------- cell.filter run helpers -------------------------

/// The SCIENTIFIC params a `cell.filter` run executes with — the shape
/// `packages/cell-filter/ui/cell-filter.yaml` emits and `cell-filter.py` reads
/// (`{column, control, min?, max?, keep?}[]` + the mask `label`).
fn filter_run_params() -> Value {
    json!({
        "criteria": [
            { "column": "pct_counts_mito", "control": "range", "max": 10 },
            { "column": "n_genes_by_counts", "control": "range", "min": 500 }
        ],
        "label": "lowqc"
    })
}

/// The first-run admin's user id (a real FK target for a seeded `jobs.owner_id`).
async fn admin_user_id(pool: &SqlitePool) -> Uuid {
    sqlx::query_scalar("SELECT id FROM users WHERE username = 'admin'")
        .fetch_one(pool)
        .await
        .expect("admin user id")
}

/// Record a REAL `cell.filter` COMPUTE run through the PRODUCTION recorder
/// (`ProvenanceRunRecorder::record_run`) over the seeded root artifact — so the
/// promoted `params` + the stashed `rerun_spec_json` are written by the very code
/// the app runs, not by a fixture row. Returns the run id.
async fn record_filter_run(pool: &SqlitePool, project_id: Uuid, root_artifact_id: Uuid) -> Uuid {
    use cytoanalyst::modules::jobs::models::Job;
    use cytoanalyst::modules::jobs::seams::{PeakMetrics, RunRecorder};
    use cytoanalyst::modules::provenance::recorder::ProvenanceRunRecorder;

    let owner = admin_user_id(pool).await;
    let job = Job {
        id: Uuid::new_v4(),
        owner_id: owner,
        job_type: "analysis".into(),
        name: "cell-filter".into(),
        status: "completed".into(),
        params: json!({
            "language": "python",
            "script": "import scanpy as sc\n",
            "analysis_id": "cell.filter",
            "inputs": [
                { "slot": "expression", "artifact_ref": root_artifact_id, "sandbox_subpath": "expression.h5ad" }
            ],
            "produces": [
                { "id": "mask", "datatype": "metadata-column", "path": "keep_lowqc.parquet", "layout": "opaque", "structure": {"encoding":"opaque","media_type":"application/octet-stream"}, "meta": {}, "role": "primary" }
            ],
            "seed": 7,
            "params": filter_run_params(),
        }),
        created_at: chrono::Utc::now(),
        started_at: None,
        finished_at: None,
        exit_code: Some(0),
        error: None,
        pid: None,
        priority_class: "normal".into(),
        resource_class: "cpu-sandbox".into(),
        req_cpu: None,
        req_mem_bytes: None,
        run_id: None,
    };
    sqlx::query("INSERT INTO jobs (id, owner_id, job_type, name, status) VALUES ($1,$2,$3,$4,$5)")
        .bind(job.id)
        .bind(job.owner_id)
        .bind(&job.job_type)
        .bind(&job.name)
        .bind(&job.status)
        .execute(pool)
        .await
        .expect("seed jobs row");
    sqlx::query("INSERT INTO job_scope (job_id, scope_kind, scope_id) VALUES ($1, 'project', $2)")
        .bind(job.id)
        .bind(project_id)
        .execute(pool)
        .await
        .expect("seed job_scope row");

    ProvenanceRunRecorder::new(pool.clone())
        .record_run(&job, &[], 0, PeakMetrics::default(), &std::env::temp_dir())
        .await;
    job.id
}

/// The recorded run node via `GET /provenance/runs/{id}`.
async fn get_run_node(server: &TestServer, token: &str, run_id: Uuid) -> Value {
    let resp = server
        .client
        .get(server.api_url(&format!("/provenance/runs/{run_id}")))
        .bearer_auth(token)
        .send()
        .await
        .expect("get run");
    assert_eq!(resp.status().as_u16(), 200, "GET runs/{{id}} is 200");
    resp.json().await.expect("run json")
}

/// The predicate assertions EVERY trust surface must satisfy (INV-2): the run
/// node's scientific params name the filtered COLUMN + its THRESHOLD, carry the
/// committed mask label, expose the re-run envelope as its own field, and contain
/// none of the runtime metadata DEC-1 dropped.
fn assert_predicate_visible(node: &Value, surface: &str) {
    let params = &node["params"];
    assert!(params.is_object(), "{surface}: the run node carries its scientific params");
    let criteria = params["criteria"]
        .as_array()
        .unwrap_or_else(|| panic!("{surface}: params carry the filter criteria, got {params}"));
    assert_eq!(criteria[0]["column"], json!("pct_counts_mito"), "{surface}: the filtered column");
    assert_eq!(criteria[0]["max"], json!(10), "{surface}: the threshold");
    assert_eq!(params["label"], json!("lowqc"), "{surface}: the committed mask label");
    assert!(params.get("language").is_none(), "{surface}: no `language` in the trust view");
    assert!(params.get("arch").is_none(), "{surface}: no `arch` in the trust view");
    assert!(
        node["rerun_spec"]["params"]["criteria"].is_array(),
        "{surface}: the re-run envelope is surfaced as its own field"
    );
}

mod authz_test;
mod code_blob_test;
mod export_replay_test;
mod fused_input_test;
mod export_test;
mod graph_test;
mod interaction_test;
mod recorder_test;
// #80 — a run's RESOLVED library versions reach `provenance_run_repro.lockfile_json`,
// the durable record, rather than living only inside a report artifact.
mod run_environment_test;
mod repeated_slot_input_test;
mod reference_test;
mod rest_test;
mod root_ingest_test;
mod rootfs_digest_test;
mod rootfs_gc_test;
mod source_dataset_test;
mod settings_test;
mod project_extension_test;
mod sync_emit_test;
mod trajectory_methods_test;
mod verify_test;
