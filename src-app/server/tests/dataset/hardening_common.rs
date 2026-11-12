//! Shared helpers for the Wave-5 pipeline-hardening suite (TEST-48..70).
//!
//! These build REAL provenance chains, jobs, workstore artifacts, and export
//! capsules against a spawned server + its per-test Postgres + its on-disk blob
//! store — the same production surfaces the pipeline uses. The provenance +
//! scheduler + manifest + readiness assertions run with NO rootfs; the capsule
//! EXECUTION assertions self-skip (via [`rootfs_gate`]) when no analysis rootfs
//! is mounted and RUN (asserting hash-for-hash) when one is.

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};
use sqlx::sqlite::SqlitePoolOptions;
use sqlx::SqlitePool;
use uuid::Uuid;

use txresbench::modules::jobs::models::Job;
use txresbench::modules::jobs::seams::{ArtifactIngestSink, PeakMetrics};
use txresbench::modules::provenance::repository::{NewRun, ProvenanceRepository};
use txresbench::modules::sandbox::outputs::ProducedOutput;
use txresbench::modules::workstore::catalog::models::{Artifact, NewArtifact};
use txresbench::modules::workstore::catalog::repository::CatalogRepository;
use txresbench::modules::workstore::ingest::ingest_run_outputs;
use txresbench::modules::workstore::object_store::{sha256_hex, LocalFsStore, ObjectStore};

use crate::common::TestServer;

// ─────────────────────────────── infra ───────────────────────────────

/// Serialize a `uuid[]` batch into the JSON-hex form the SQLite membership
/// predicates consume (`IN (SELECT unhex(j.value) FROM json_each($1) AS j)` —
/// the ITEM-15/19 convention; a hyphenated TEXT list never matches a BLOB).
pub fn uuid_list_json(ids: &[Uuid]) -> String {
    serde_json::to_string(
        &ids.iter()
            .map(|id| id.simple().to_string())
            .collect::<Vec<String>>(),
    )
    .expect("Vec<String> is JSON-serializable")
}

/// A pool against the spawned server's per-test DB (for direct catalog/provenance
/// seeding + row-level assertions the REST surface has no endpoint for).
pub async fn pool_for(server: &TestServer) -> SqlitePool {
    SqlitePoolOptions::new()
        .max_connections(4)
        .connect(server.database_url())
        .await
        .expect("connect test pool")
}

/// The path root of the SERVER's content-addressed blob store, so a blob written
/// here is readable by the spawned server's export/ingest (mirrors the workstore
/// + promote tests).
pub fn store_root(server: &TestServer) -> PathBuf {
    server.data_dir().join("workstore")
}

/// A store rooted at the server's workstore blob dir.
pub fn server_store(server: &TestServer) -> LocalFsStore {
    LocalFsStore::new(store_root(server))
}

// ─────────────────────────────── auth / scope ───────────────────────────────

/// Create a project → its id.
pub async fn create_project(server: &TestServer, token: &str, name: &str) -> Uuid {
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

/// Attach a dataset to a project (M:N) → 200.
pub async fn attach_dataset(server: &TestServer, token: &str, project_id: Uuid, dataset_id: Uuid) {
    let resp = server
        .client
        .post(server.api_url(&format!("/projects/{project_id}/datasets/{dataset_id}")))
        .bearer_auth(token)
        .send()
        .await
        .expect("attach dataset");
    assert_eq!(
        resp.status().as_u16(),
        200,
        "attach {dataset_id} → {project_id}"
    );
}

/// Create a metadata-only dataset → its id.
pub async fn new_dataset(server: &TestServer, token: &str, name: &str) -> Uuid {
    let resp = server
        .client
        .post(server.api_url("/datasets"))
        .bearer_auth(token)
        .json(&json!({ "name": name }))
        .send()
        .await
        .expect("create dataset");
    assert_eq!(resp.status().as_u16(), 201, "create dataset {name}");
    let body: Value = resp.json().await.expect("dataset json");
    Uuid::parse_str(body["id"].as_str().expect("dataset id")).unwrap()
}

/// Upload one real file into a dataset (the txresbench-file path). Returns
/// `(dataset_id, file_id, content_hash)`. A single-file dataset's `content_hash`
/// is `sha256:<blob-hex>` — the byte source a `data/<hash>` capsule member draws.
pub async fn upload_dataset(
    server: &TestServer,
    token: &str,
    name: &str,
    filename: &str,
    bytes: &[u8],
) -> (Uuid, Uuid, String) {
    let dataset_id = new_dataset(server, token, name).await;
    let form = reqwest::multipart::Form::new().part(
        "file",
        reqwest::multipart::Part::bytes(bytes.to_vec()).file_name(filename.to_string()),
    );
    let resp = server
        .client
        .post(server.api_url(&format!("/datasets/{dataset_id}/upload")))
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await
        .expect("upload dataset file");
    assert_eq!(resp.status().as_u16(), 200, "upload {filename}");
    // DatasetFileUploadResponse { file_id, detected_datatype, dataset }.
    let body: Value = resp.json().await.expect("upload json");
    let file_id = Uuid::parse_str(body["file_id"].as_str().expect("file id")).unwrap();
    let content_hash = body["dataset"]["content_hash"]
        .as_str()
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("sha256:{}", sha256_hex(bytes)));
    (dataset_id, file_id, content_hash)
}

// ─────────────────────────── provenance seeding ───────────────────────────

/// A `NewRun` with sensible defaults (`kind="compute"`, `status="completed"`,
/// `seed=0`, empty inputs). Mutate the returned struct then [`insert_run`].
pub fn run_template(run_id: Uuid, project_id: Option<Uuid>, dataset_id: Option<Uuid>) -> NewRun {
    NewRun {
        run_id,
        project_id,
        dataset_id,
        kind: "compute".into(),
        status: "completed".into(),
        generator_id: "analysis".into(),
        generator_version: "test".into(),
        code_sha256: None,
        env_rootfs_sha256: None,
        lockfile_json: None,
        seed: Some(0),
        params: json!({ "seed": 0, "language": "python" }),
        inputs_json: json!([]),
        acting_user: None,
        rerun_spec_json: None,
    }
}

/// A distinct deterministic `sha256:<hex>` content hash keyed by a small tag byte
/// (tag 1 → `sha256:0101…01`). For pure-graph tests that need many DISTINCT,
/// stable, non-colliding hashes without real blobs.
pub fn h(tag: u8) -> String {
    let hex: String = std::iter::repeat(format!("{tag:02x}")).take(32).collect();
    format!("sha256:{hex}")
}

/// A single used-edge value (the inline `inputs_json` element form the walk reads).
pub fn used_edge(slot: &str, kind: &str, ref_id: Option<Uuid>, content_hash: &str) -> Value {
    match ref_id {
        Some(id) => {
            json!({ "slot": slot, "kind": kind, "ref_id": id, "content_hash": content_hash })
        }
        None => json!({ "slot": slot, "kind": kind, "content_hash": content_hash }),
    }
}

/// Insert a run node.
pub async fn insert_run(pool: &SqlitePool, run: &NewRun) {
    ProvenanceRepository::new(pool.clone())
        .insert_run(run)
        .await
        .expect("insert run");
}

/// Store an emitted source as a `provenance_code_blobs` row (dedup by sha256),
/// returning its sha256. Mirrors `capture::store_code`.
pub async fn store_code(pool: &SqlitePool, source: &str, language: &str) -> String {
    let sha = sha256_hex(source.as_bytes());
    ProvenanceRepository::new(pool.clone())
        .insert_code_blob(&sha, language, source, source.len() as i64)
        .await
        .expect("insert code blob");
    sha
}

/// Seed a catalog artifact (a run OUTPUT when `run_id` is Some, a ROOT when None).
/// `content_hash` doubles as the `object_key` (no blob written — for pure-graph
/// tests). Returns the artifact id.
#[allow(clippy::too_many_arguments)]
pub async fn seed_artifact(
    pool: &SqlitePool,
    project_id: Option<Uuid>,
    dataset_id: Option<Uuid>,
    run_id: Option<Uuid>,
    output_id: &str,
    content_hash: &str,
    datatype: &str,
    is_multifile: bool,
) -> Uuid {
    CatalogRepository::new(pool.clone())
        .insert_artifact(&NewArtifact {
            project_id,
            dataset_id,
            run_id,
            output_id: output_id.into(),
            datatype: datatype.into(),
            object_key: Some(content_hash.into()),
            is_multifile,
            content_hash: content_hash.into(),
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
        .expect("seed artifact")
        .id
}

/// Seed a REAL-blob-backed artifact (its bytes land in the server's store so an
/// export can fetch them). Returns `(artifact_id, content_hash)`.
#[allow(clippy::too_many_arguments)]
pub async fn seed_blob_artifact(
    server: &TestServer,
    project_id: Option<Uuid>,
    dataset_id: Option<Uuid>,
    run_id: Option<Uuid>,
    output_id: &str,
    bytes: &[u8],
    datatype: &str,
) -> (Uuid, String) {
    let key = server_store(server).put(bytes).await.expect("put blob");
    let content_hash = key.as_str().to_string();
    let pool = pool_for(server).await;
    let id = CatalogRepository::new(pool)
        .insert_artifact(&NewArtifact {
            project_id,
            dataset_id,
            run_id,
            output_id: output_id.into(),
            datatype: datatype.into(),
            object_key: Some(content_hash.clone()),
            is_multifile: false,
            content_hash: content_hash.clone(),
            structure: serde_json::json!({ "encoding": "opaque", "media_type": "application/octet-stream" }),
            meta: serde_json::json!({}),
            role: "artifact".to_string(),
            stored_bytes: bytes.len() as i64,
            logical_bytes: Some(bytes.len() as i64),
            created_by: None,
            hidden: false,
            representation_of: None,
        })
        .await
        .expect("seed blob artifact")
        .id;
    (id, content_hash)
}

/// One declared output for [`ingest_manifest`]: a single-file blob OR a
/// multi-file dir (member `(rel, bytes)` list).
pub struct OutSpec {
    pub id: String,
    pub datatype: String,
    pub layout: String,
    pub role: String,
    pub single: Option<Vec<u8>>,
    pub dir: Option<Vec<(String, Vec<u8>)>>,
}

impl OutSpec {
    pub fn file(id: &str, datatype: &str, bytes: &[u8], role: &str) -> Self {
        Self {
            id: id.into(),
            datatype: datatype.into(),
            layout: "opaque".into(),
            role: role.into(),
            single: Some(bytes.to_vec()),
            dir: None,
        }
    }
    pub fn multifile(
        id: &str,
        datatype: &str,
        layout: &str,
        members: &[(&str, &[u8])],
        role: &str,
    ) -> Self {
        Self {
            id: id.into(),
            datatype: datatype.into(),
            layout: layout.into(),
            role: role.into(),
            single: None,
            dir: Some(
                members
                    .iter()
                    .map(|(r, b)| (r.to_string(), b.to_vec()))
                    .collect(),
            ),
        }
    }
}

/// Stage a real `/outputs/manifest.json` + its files under a fresh workspace and
/// drive the REAL working-store ingest (blobs land in the server's store).
/// Returns the cataloged rows. `workspace` (returned) is left on disk so a caller
/// can assert workspace-preservation.
pub async fn ingest_manifest(
    server: &TestServer,
    pool: &SqlitePool,
    project_id: Option<Uuid>,
    dataset_id: Option<Uuid>,
    run_id: Uuid,
    outs: &[OutSpec],
) -> Vec<Artifact> {
    let (ws, _) = stage_manifest(server, run_id, outs).await;
    let store = server_store(server);
    ingest_run_outputs(pool, &store, project_id, dataset_id, run_id, None, &ws)
        .await
        .expect("ingest run outputs")
}

/// Stage a `/outputs/manifest.json` + files (no ingest). Returns
/// `(workspace_dir, manifest_json)`. Each single output writes `outputs/<id>.bin`;
/// each multi-file output writes `outputs/<id>/<member>`.
pub async fn stage_manifest(
    server: &TestServer,
    run_id: Uuid,
    outs: &[OutSpec],
) -> (PathBuf, Value) {
    let ws = server
        .data_dir()
        .join(format!("hardening-ws-{run_id}-{}", Uuid::new_v4()));
    let outputs = ws.join("outputs");
    tokio::fs::create_dir_all(&outputs).await.unwrap();
    let mut manifest_outs = Vec::new();
    for o in outs {
        let path;
        if let Some(bytes) = &o.single {
            path = format!("{}.bin", o.id);
            tokio::fs::write(outputs.join(&path), bytes).await.unwrap();
        } else if let Some(members) = &o.dir {
            path = o.id.clone();
            for (rel, bytes) in members {
                let p = outputs.join(&path).join(rel);
                tokio::fs::create_dir_all(p.parent().unwrap())
                    .await
                    .unwrap();
                tokio::fs::write(&p, bytes).await.unwrap();
            }
        } else {
            path = format!("{}.bin", o.id);
            tokio::fs::write(outputs.join(&path), b"").await.unwrap();
        }
        manifest_outs.push(json!({
            "id": o.id, "datatype": o.datatype, "path": path, "layout": o.layout, "role": o.role,
            // ITEM-5/6: `structure`/`meta` are REQUIRED on a manifest entry (no serde
            // default) — a producer declaring neither is refused at ingest. These
            // fixtures emit opaque bytes, so they declare exactly that. Stated at both
            // emit sites in this file because every OutSpec-built manifest flows through
            // one of them; per-test literals are how five suites drifted apart.
            "structure": { "encoding": "opaque", "media_type": "application/octet-stream" },
            "meta": {}
        }));
    }
    let manifest = json!({ "outputs": manifest_outs });
    tokio::fs::write(
        outputs.join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .await
    .unwrap();
    (ws, manifest)
}

// ──────────────────────── provenance REST reads ────────────────────────

/// `GET /provenance/graph?project_id=&target=` → the graph JSON. Asserts 200.
pub async fn get_graph(
    server: &TestServer,
    token: &str,
    project_id: Uuid,
    target: Option<Uuid>,
) -> Value {
    let mut url = format!("/provenance/graph?project_id={project_id}");
    if let Some(t) = target {
        url.push_str(&format!("&target={t}"));
    }
    let resp = server
        .client
        .get(server.api_url(&url))
        .bearer_auth(token)
        .send()
        .await
        .expect("get graph");
    assert_eq!(resp.status().as_u16(), 200, "graph read is 200");
    resp.json().await.expect("graph json")
}

/// `GET /provenance/forward?dataset_id=` → the raw response (caller asserts status).
pub async fn get_forward_resp(
    server: &TestServer,
    token: &str,
    dataset_id: Uuid,
) -> reqwest::Response {
    server
        .client
        .get(server.api_url(&format!("/provenance/forward?dataset_id={dataset_id}")))
        .bearer_auth(token)
        .send()
        .await
        .expect("get forward")
}

/// `POST /provenance/export {project_id, target?, scope}` → `export_id`. Asserts 200.
pub async fn export_bundle(
    server: &TestServer,
    token: &str,
    project_id: Uuid,
    target: Option<Uuid>,
    scope: &str,
) -> String {
    let mut body = json!({ "project_id": project_id, "scope": scope });
    if let Some(t) = target {
        body["target"] = json!(t);
    }
    let resp = server
        .client
        .post(server.api_url("/provenance/export"))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .expect("export");
    assert_eq!(resp.status().as_u16(), 200, "export build is 200");
    resp.json::<Value>().await.expect("export json")["export_id"]
        .as_str()
        .expect("export_id")
        .to_string()
}

/// `GET /provenance/export/{id}` → the zip bytes. Asserts 200 + zip magic.
pub async fn download_zip(server: &TestServer, token: &str, export_id: &str) -> Vec<u8> {
    let resp = server
        .client
        .get(server.api_url(&format!("/provenance/export/{export_id}")))
        .bearer_auth(token)
        .send()
        .await
        .expect("download export");
    assert_eq!(resp.status().as_u16(), 200, "download is 200");
    let bytes = resp.bytes().await.expect("zip bytes").to_vec();
    assert!(
        bytes.len() > 4 && &bytes[..4] == b"PK\x03\x04",
        "valid zip magic"
    );
    bytes
}

/// Parse a STORE-method (uncompressed) zip — the exact format
/// `provenance::export::bundle::zipstore` writes — into `(name, bytes)` members.
/// Walks the sequential local-file headers until the central directory.
pub fn unzip_store(zip: &[u8]) -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i + 30 <= zip.len() && &zip[i..i + 4] == b"PK\x03\x04" {
        let comp_size =
            u32::from_le_bytes([zip[i + 18], zip[i + 19], zip[i + 20], zip[i + 21]]) as usize;
        let nlen = u16::from_le_bytes([zip[i + 26], zip[i + 27]]) as usize;
        let elen = u16::from_le_bytes([zip[i + 28], zip[i + 29]]) as usize;
        let name_start = i + 30;
        let data_start = name_start + nlen + elen;
        let name = String::from_utf8_lossy(&zip[name_start..name_start + nlen]).to_string();
        let data = zip[data_start..data_start + comp_size].to_vec();
        out.push((name, data));
        i = data_start + comp_size;
    }
    out
}

// ─────────────────────────────── jobs / scheduler ───────────────────────────

/// Submit a stub job (`job_type="stub"` → a real `sh -c` child, NO rootfs).
/// `params` typically `{ "steps": N }` (~1s/step) or `{ "steps": N, "timeout_secs": T }`.
/// Optional `priority_class` (interactive|normal|batch). Returns the job id.
pub async fn submit_stub(
    server: &TestServer,
    token: &str,
    name: &str,
    params: Value,
    priority_class: Option<&str>,
) -> Uuid {
    let mut body = json!({ "job_type": "stub", "name": name, "params": params });
    if let Some(pc) = priority_class {
        body["priority_class"] = json!(pc);
    }
    let resp = server
        .client
        .post(server.api_url("/jobs"))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .expect("submit job");
    assert_eq!(
        resp.status().as_u16(),
        201,
        "submit stub {name}: {}",
        resp.status()
    );
    let body: Value = resp.json().await.expect("job json");
    assert_eq!(body["status"], "queued", "a fresh job is queued");
    Uuid::parse_str(body["id"].as_str().unwrap()).unwrap()
}

/// `POST /jobs/{id}/stop` → the raw response.
pub async fn stop_job(server: &TestServer, token: &str, id: Uuid) -> reqwest::Response {
    server
        .client
        .post(server.api_url(&format!("/jobs/{id}/stop")))
        .bearer_auth(token)
        .send()
        .await
        .expect("stop job")
}

/// `GET /jobs/{id}` → the `JobDetail` JSON.
pub async fn get_job(server: &TestServer, token: &str, id: Uuid) -> Value {
    server
        .client
        .get(server.api_url(&format!("/jobs/{id}")))
        .bearer_auth(token)
        .send()
        .await
        .expect("get job")
        .json()
        .await
        .expect("job detail")
}

/// The `(status, started_at.is_some, finished_at.is_some, error)` of a job row —
/// read straight from the DB for precise scheduler assertions.
pub async fn job_row(pool: &SqlitePool, id: Uuid) -> (String, bool, bool, Option<String>) {
    let row: (
        String,
        Option<chrono::DateTime<chrono::Utc>>,
        Option<chrono::DateTime<chrono::Utc>>,
        Option<String>,
    ) = sqlx::query_as("SELECT status, started_at, finished_at, error FROM jobs WHERE id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .expect("job row");
    (row.0, row.1.is_some(), row.2.is_some(), row.3)
}

/// The started_at timestamp of a job (None until claimed).
pub async fn job_started_at(pool: &SqlitePool, id: Uuid) -> Option<chrono::DateTime<chrono::Utc>> {
    sqlx::query_scalar("SELECT started_at FROM jobs WHERE id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .expect("started_at")
}

/// Count of currently-`running` jobs (the concurrency-cap probe).
pub async fn count_running(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM jobs WHERE status = 'running'")
        .fetch_one(pool)
        .await
        .expect("count running")
}

/// PUT /job-settings (admin) — set the concurrency cap + reserved interactive slots.
pub async fn set_job_settings(
    server: &TestServer,
    admin: &str,
    max_concurrent: i32,
    reserved: i32,
) {
    let resp = server
        .client
        .put(server.api_url("/job-settings"))
        .bearer_auth(admin)
        .json(&json!({ "max_concurrent_jobs": max_concurrent, "reserved_interactive_slots": reserved }))
        .send()
        .await
        .expect("put job settings");
    assert_eq!(
        resp.status().as_u16(),
        200,
        "set job settings: {}",
        resp.status()
    );
}

/// Poll a job row until `status` is terminal (completed|failed|stopped) or timeout.
/// Returns the terminal status (panics on timeout).
pub async fn wait_terminal(pool: &SqlitePool, id: Uuid, timeout: Duration) -> String {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let (status, ..) = job_row(pool, id).await;
        if matches!(status.as_str(), "completed" | "failed" | "stopped") {
            return status;
        }
        if tokio::time::Instant::now() >= deadline {
            panic!("job {id} did not reach a terminal state within {timeout:?} (last={status})");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Poll `GET /jobs/{id}` until the job is terminal → `(status, job_detail_body)`. PANICS on
/// timeout with the last observed body — a converter that never settles must fail LOUDLY,
/// never silently burn the deadline and report "no terminal state".
///
/// Read the status at **`body["job"]["status"]`**: `GET /jobs/{id}` answers a `JobDetail`
/// (`{ job, logs, metrics, milestones }`), NOT a bare `Job` (only `POST /jobs` returns the
/// flat row). Three rootfs-gated converter tests each carried a private copy of this poller
/// reading `body["status"]`, which is always absent → `""` → never terminal. Those tests
/// self-skip without a mounted rootfs, so the mis-read was invisible on an ordinary box; on a
/// rootfs-capable one it looked exactly like "the converter job never reaches a terminal state
/// within N seconds" while the job had in fact already failed within ~2s. One shared helper,
/// one correct path.
pub async fn poll_job_terminal_api(
    server: &TestServer,
    token: &str,
    job_id: &str,
    overall: Duration,
) -> (String, Value) {
    let deadline = tokio::time::Instant::now() + overall;
    loop {
        let body: Value = server
            .client
            .get(server.api_url(&format!("/jobs/{job_id}")))
            .bearer_auth(token)
            .send()
            .await
            .expect("GET /jobs/{id}")
            .json()
            .await
            .unwrap_or(Value::Null);
        let status = body["job"]["status"].as_str().unwrap_or("").to_string();
        if matches!(status.as_str(), "completed" | "failed" | "stopped") {
            return (status, body);
        }
        if tokio::time::Instant::now() >= deadline {
            panic!(
                "job {job_id} did not reach a terminal state within {overall:?}; \
                 last GET /jobs/{{id}} body = {body}"
            );
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// Poll until a job's `started_at` is set (it was claimed) or timeout. Returns
/// whether it started within the window.
pub async fn wait_started(pool: &SqlitePool, id: Uuid, timeout: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if job_started_at(pool, id).await.is_some() {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// A REAL artifact-ingest sink for the reconcile path: it drives the actual
/// `ingest_run_outputs` (real blobs + real catalog) with an explicit scope + store
/// (the process-wide `WorkstoreIngestSink` needs the server-process object store,
/// which the test process lacks). Exercises the SAME ingest the production sink
/// calls, so idempotency + no-double-insert are proven for real.
pub struct RealIngest {
    pub pool: SqlitePool,
    pub store_root: PathBuf,
    pub project_id: Option<Uuid>,
    pub dataset_id: Option<Uuid>,
}

#[async_trait]
impl ArtifactIngestSink for RealIngest {
    async fn ingest_outputs(
        &self,
        job: &Job,
        _outputs: &[ProducedOutput],
        workspace_root: &Path,
    ) -> Result<(), String> {
        let store = LocalFsStore::new(self.store_root.clone());
        let run_id = job.run_id.unwrap_or(job.id);
        ingest_run_outputs(
            &self.pool,
            &store,
            self.project_id,
            self.dataset_id,
            run_id,
            Some(job.owner_id),
            workspace_root,
        )
        .await
        .map(|_| ())
        .map_err(|e| format!("{e:?}"))
    }
}

pub const PEAK_NONE: PeakMetrics = PeakMetrics {
    mem_peak_bytes: None,
    pids_peak: None,
    cpu_usage_usec: None,
    wall_ms: None,
    gpu_secs: None,
};

/// The user id of the first-run admin (owner of raw-inserted jobs).
pub async fn admin_user_id(pool: &SqlitePool) -> Uuid {
    sqlx::query_scalar("SELECT id FROM users WHERE username = 'admin'")
        .fetch_one(pool)
        .await
        .expect("admin user id")
}

/// Raw-INSERT an orphaned `running` job (simulating one left mid-flight by a
/// crash) — the crash-recovery / reconcile seed. `run_id` falls back to the job id.
/// A `dataset_id` scope lands as a `job_scope` row (ITEM-68 — the jobs table is
/// scope-agnostic; a dataset-scoped run's scope lives in `job_scope`).
pub async fn insert_running_job(
    pool: &SqlitePool,
    owner_id: Uuid,
    job_type: &str,
    dataset_id: Option<Uuid>,
) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO jobs (id, owner_id, job_type, name, status, params, priority_class, resource_class, created_at, started_at)
         VALUES ($1, $2, $3, 'reconcile-seed', 'running', '{}', 'normal', 'cpu-sandbox', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
    )
    .bind(id)
    .bind(owner_id)
    .bind(job_type)
    .execute(pool)
    .await
    .expect("insert running job");
    if let Some(ds) = dataset_id {
        sqlx::query(
            "INSERT INTO job_scope (job_id, scope_kind, scope_id) VALUES ($1, 'dataset', $2)",
        )
        .bind(id)
        .bind(ds)
        .execute(pool)
        .await
        .expect("insert job_scope (dataset) row");
    }
    id
}

/// The per-server sandbox WORKSPACE root the reconcile scans
/// (`<data_dir>/sandboxes/<job_id>/` — `inputs/`, `code/`, scratch).
pub fn sandboxes_root(server: &TestServer) -> PathBuf {
    server.data_dir().join("sandboxes")
}

/// The per-server output STAGING root (ITEM-17), a SIBLING of [`sandboxes_root`]:
/// `<data_dir>/run-staging/<job_id>/outputs/`. Mirrors what
/// `sandbox::outputs::staging_root()` derives from the real `data_root()`, which is
/// the root `JobsModule::init` hands the reconcile.
pub fn run_staging_root(server: &TestServer) -> PathBuf {
    server.data_dir().join("run-staging")
}

/// Stage a crashed run's TWO dirs the way a live run leaves them (ITEM-17): a
/// workspace under [`sandboxes_root`] and, in a SEPARATE tree under
/// [`run_staging_root`], the outputs the child wrote. Returns
/// `(workspace_dir, staging_dir)`.
///
/// Both per-run paths come from the production helpers (`outputs::staging_dir` /
/// `outputs::outputs_dir`) rather than a literal `join("outputs")`, so the fixture
/// cannot drift from the layout the reconcile actually reads.
///
/// When `outs` is empty, both dirs are created but NO manifest is written — a
/// mid-run crash, which is what makes the run unfinalizable.
pub async fn stage_job_run_dirs(
    server: &TestServer,
    job_id: Uuid,
    outs: &[OutSpec],
) -> (PathBuf, PathBuf) {
    let job_dir = sandboxes_root(server).join(job_id.to_string());
    tokio::fs::create_dir_all(&job_dir).await.unwrap();
    let staging_dir =
        txresbench::modules::sandbox::outputs::staging_dir(&run_staging_root(server), job_id);
    let outputs = txresbench::modules::sandbox::outputs::outputs_dir(&staging_dir);
    tokio::fs::create_dir_all(&outputs).await.unwrap();
    if outs.is_empty() {
        // What a killed child actually leaves behind: a partial write, no manifest.
        tokio::fs::write(outputs.join("partial.tmp"), b"half")
            .await
            .unwrap();
        return (job_dir, staging_dir);
    }
    let mut manifest_outs = Vec::new();
    for o in outs {
        let path = if let Some(bytes) = &o.single {
            let p = format!("{}.bin", o.id);
            tokio::fs::write(outputs.join(&p), bytes).await.unwrap();
            p
        } else {
            format!("{}.bin", o.id)
        };
        manifest_outs.push(json!({
            "id": o.id, "datatype": o.datatype, "path": path, "layout": o.layout, "role": o.role,
            // ITEM-5/6: `structure`/`meta` are REQUIRED on a manifest entry (no serde
            // default) — a producer declaring neither is refused at ingest. These
            // fixtures emit opaque bytes, so they declare exactly that. Stated at both
            // emit sites in this file because every OutSpec-built manifest flows through
            // one of them; per-test literals are how five suites drifted apart.
            "structure": { "encoding": "opaque", "media_type": "application/octet-stream" },
            "meta": {}
        }));
    }
    tokio::fs::write(
        outputs.join("manifest.json"),
        serde_json::to_vec(&json!({ "outputs": manifest_outs })).unwrap(),
    )
    .await
    .unwrap();
    (job_dir, staging_dir)
}

// ─────────────────────────────── rootfs gate ───────────────────────────────

/// Runtime rootfs availability for the executable-capsule tests. Returns
/// `Some(env_digest)` when the analysis sandbox is READY (so a rootfs-gated test
/// RUNS + asserts hash-for-hash) or `None` when absent (the test SELF-SKIPS with a
/// clear log — never a compile-time ignore). Honors either the `TXR_SANDBOX_ROOTFS` seam
/// (matching the existing suite) or the authoritative `GET /sandbox/status`
/// (`availability == "ready"` / `rootfs.supported`).
pub async fn rootfs_gate(server: &TestServer, admin: &str) -> Option<String> {
    let st: Value = server
        .client
        .get(server.api_url("/sandbox/status"))
        .bearer_auth(admin)
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let digest = st["rootfs"]["content_sha256"]
        .as_str()
        .unwrap_or("")
        .to_string();
    let ready = st["availability"] == "ready";
    let supported = st["rootfs"]["supported"].as_bool().unwrap_or(false);
    // Under the OCI fetch-newest model nothing is embedded, so `content_sha256` is
    // empty until a lazy pull happens — the old `digest.is_empty()` early-return
    // would wrongly self-skip. Honor the pre-mounted-rootfs seam
    // (`TXR_ENV_ROOTFS_SQUASHFS` / `TXR_ENV_ROOTFS_DIR`, the provider's air-gap
    // overrides) OR the legacy `TXR_SANDBOX_ROOTFS`: when any is set, availability
    // is the mounted rootfs, and the real execute-probe below is the authoritative
    // readiness gate. Only `TXR_ENV_ROOTFS_SQUASHFS` (or a live OCI pull) PINS an
    // env digest, which is what an EXECUTABLE capsule additionally needs — see
    // `pinned_env_digest`.
    //
    // With NO seam set at all the LIVE OCI path is still the production answer
    // (`oras resolve` the moving schema+arch tag → cosign-verify → pull → mount),
    // and it pins a digest too. So a host that merely HAS `oras` must not
    // self-skip on the embedded-stub status: fall through to the authoritative
    // execute-probe below, which drives that exact path. An unreachable registry
    // makes the probe fail fast and the test self-skips there instead — honest
    // either way, and zero-config on a capable host.
    let env_seam = [
        "TXR_SANDBOX_ROOTFS",
        "TXR_ENV_ROOTFS_DIR",
        "TXR_ENV_ROOTFS_SQUASHFS",
    ]
    .iter()
    .any(|k| std::env::var(k).map(|v| !v.is_empty()).unwrap_or(false));
    if !env_seam && !oras_available() && (digest.is_empty() || !(ready || supported)) {
        return None;
    }
    // The rootfs is present, but a reproduce test ALSO needs the sandbox to
    // actually EXECUTE — a PID namespace with a fresh `/proc`. An unprivileged
    // container (`CapEff=0`, e.g. docker-in-docker) can't mount proc in a nested
    // PID-ns, so the sandbox CORRECTLY disables itself (a no-PID-ns fallback would
    // let sandboxed code read the server's `/proc/<pid>/environ`). Probe a trivial
    // run and self-skip when it can't execute — so a capability-limited host
    // self-skips (never a compile-time ignore, never false-fails); the run reproduces
    // hash-for-hash on any CAP_SYS_ADMIN-capable host.
    let probe: Value = server
        .client
        .post(server.api_url("/sandbox/execute"))
        .bearer_auth(admin)
        .json(&serde_json::json!({ "command": "echo probe" }))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    if probe["exit_code"] != serde_json::json!(0) {
        return None;
    }
    // `rootfs.content_sha256` is the EMBEDDED digest, which is permanently empty
    // under the OCI fetch-newest model (nothing is embedded) — returning it would
    // hand callers `""` as "the digest that ran". The probe above just forced a
    // real `provide()`, so the digest that ACTUALLY ran is the one now staged in
    // this server's own content-digest cache; read it from there.
    Some(digest)
        .filter(|d| !d.is_empty())
        .or_else(|| mounted_env_digest(server))
}

/// Is the `oras` host binary present? (probed once per test binary — `provide()`
/// needs it for the live OCI env-image path). Cached so the gate never spawns a
/// subprocess per test.
fn oras_available() -> bool {
    static OK: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *OK.get_or_init(|| {
        std::process::Command::new("oras")
            .arg("version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    })
}

/// Obtain a SECOND, genuinely-distinct PUBLISHED env image and stage it into this
/// server's own digest cache, so `GET /sandbox/rootfs/{hex}` serves it and a
/// heterogeneous-environment capsule can mount it. Returns its content digest.
///
/// This is a REAL second environment, not a fabricated one: the per-env repo
/// publishes an immutable `schema<N>-<commit>-<arch>` tag per build alongside the
/// moving `schema<N>-latest-<arch>`, so a DIFFERENT published build is a real
/// "some other app version" env for the cross-version capsule to mount. Resolved
/// + cosign-verified + pulled through the same `oras`/`cosign` chain the runtime
/// provider uses.
///
/// `Err(reason)` is an ENVIRONMENTAL gate and the `reason` is the caller's skip
/// text, so it must be TRUE of the box it is printed on. Each arm below therefore
/// names the one thing that actually failed — `oras` missing, the registry
/// unreadable, only ONE build published, cosign refusing, the pull failing —
/// instead of a single catch-all. The previous catch-all read "no oras/registry
/// reach" on a host with `oras` AND `cosign` installed and the registry resolving,
/// which is precisely the misdirection a ledger exists to prevent.
///
/// A missing extension registry is NOT one of these arms — see the `panic!` below.
///
/// The choice among the eligible tags is ARBITRARY (see the selection comment
/// below) — the test only needs `d2 != d1`, not a specific age ordering.
pub async fn stage_second_env_image(
    server: &TestServer,
    exclude_digest: &str,
) -> Result<String, String> {
    use txresbench::modules::sandbox::env_image;

    // ── HARNESS FAULT, NOT AN ENVIRONMENT GATE ──────────────────────────────────
    // `default_env_id()` reads the process-global EXTENSION registry, which
    // `common::ensure_extension_registry` publishes from `TestServer::spawn` the
    // way boot does. Before that publication moved into the harness it was owned
    // by `analysis::mod` alone, so this helper returned `None` — and TEST-68
    // silently self-skipped with a FALSE reason — whenever no `analysis::*` test
    // shared the invocation. Selector-dependent, on an acceptance test.
    //
    // So this case is deliberately NOT recoverable here: if the harness init ever
    // stops publishing, or the tree stops declaring a converter env, the honest
    // report is RED with the cause named — never a skip that reads like a
    // capability the box lacks.
    if txresbench::modules::extensions::try_registry().is_none() {
        panic!(
            "stage_second_env_image: the process-global EXTENSION registry is not published, so \
             `env_image::default_env_id()` cannot resolve an env-id. This is a HARNESS fault, not \
             a property of this host: `common::ensure_extension_registry()` (called by \
             `TestServer::spawn`) publishes it the way boot does. Restore that call — do NOT \
             convert this back into a self-skip, which is how TEST-68 came to execute or not \
             depending on which other test module shared the invocation."
        );
    }
    let Some(env_id) = env_image::default_env_id() else {
        panic!(
            "stage_second_env_image: the extension registry IS published but no contributed \
             converter declares `run.env` (`contributes.converters[].env`), so there is no default \
             env-id. That is a TREE defect — the sandbox run path has no rootfs to provide either \
             — not a capability this host lacks."
        );
    };
    let r = env_image::resolve(&env_id).ok_or_else(|| {
        format!(
            "env-id {env_id:?} is not a legal OCI repository path component, so it resolves to \
             no image reference"
        )
    })?;
    if !oras_available() {
        return Err(
            "the `oras` host binary is not installed, so no published env image can be resolved \
             or pulled"
                .to_string(),
        );
    }
    let oras = |args: &[&str]| -> Option<String> {
        let out = std::process::Command::new("oras")
            .args(args)
            .output()
            .ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    };

    // Immutable per-build tags for THIS binary's schema + arch; the moving
    // `latest` alias is excluded (it is `exclude_digest`).
    //
    // The `sort()` below is for DETERMINISM ONLY, not recency: a tag is
    // `schema<N>-<commit-sha>-<arch>` (`.github/workflows/env-images.yml`), so
    // after the fixed `schema<N>-` prefix the sort key is the commit SHA, which is
    // uncorrelated with build time — first-after-sort lands on the newest build at
    // chance (~1/N). That is fine and deliberate: this helper only owes the caller
    // a build DISTINCT from `exclude_digest`. Do NOT "fix" the order by reversing
    // it — to actually order by age you would have to resolve each candidate and
    // read its `org.opencontainers.image.created` annotation.
    let arch_suffix = r
        .tag
        .rsplit('-')
        .next()
        .ok_or_else(|| format!("moving tag {:?} carries no arch suffix", r.tag))?
        .to_string();
    let schema_prefix = r
        .tag
        .split('-')
        .next()
        .ok_or_else(|| format!("moving tag {:?} carries no schema prefix", r.tag))?
        .to_string();
    let tags = oras(&["repo", "tags", &r.oci_ref]).ok_or_else(|| {
        format!(
            "`oras repo tags {}` failed — the registry is unreachable, the repo does not exist, \
             or this host is not authorized to list it",
            r.oci_ref
        )
    })?;
    let mut candidates: Vec<String> = tags
        .lines()
        .map(|t| t.trim().to_string())
        .filter(|t| {
            t.starts_with(&schema_prefix)
                && t.ends_with(&arch_suffix)
                && !t.contains("latest")
                && !t.starts_with("sha256-")
        })
        .collect();
    candidates.sort();
    let n_candidates = candidates.len();

    let mut chosen: Option<(String, String)> = None;
    for tag in candidates {
        let pull_ref = format!("{}:{tag}", r.oci_ref);
        let Some(d) = oras(&["resolve", &pull_ref]) else {
            continue;
        };
        let hex = d.strip_prefix("sha256:").unwrap_or(&d).to_string();
        if hex.len() == 64 && hex != exclude_digest {
            chosen = Some((format!("{}@{d}", r.oci_ref), hex));
            break;
        }
    }
    let Some((pinned, hex)) = chosen else {
        return Err(format!(
            "{} reachable, but no published build for {schema_prefix}+{arch_suffix} resolves to a \
             digest distinct from the mounted one ({n_candidates} immutable build tag(s) \
             examined) — this schema+arch has only ever had ONE build published",
            r.oci_ref
        ));
    };

    // Never stage an unverified image, even in a test: it must still be signed by
    // THIS repo's `env-images.yml` workflow. The identity is the repo's own
    // documented STAGING regexp (`TXR_ENV_IMAGE_IDENTITY_REGEXP`,
    // `@refs/(heads|tags)/…`) rather than the production `@refs/heads/main`,
    // because the older builds this test needs were published pre-merge and carry
    // the tag identity. Widening it HERE does not touch the runtime provider,
    // whose default stays strict-main.
    let verified = std::process::Command::new("cosign")
        .args([
            "verify",
            "--certificate-oidc-issuer",
            "https://token.actions.githubusercontent.com",
            "--certificate-identity-regexp",
            r"^https://github\.com/tinnlab/txresbench/\.github/workflows/env-images\.yml@refs/(heads|tags)/.+$",
            &pinned,
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !verified {
        return Err(format!(
            "cosign verify refused {pinned} (issuer token.actions.githubusercontent.com, identity \
             env-images.yml@refs/(heads|tags)/…) — an unverified image is never staged, not even \
             for a test"
        ));
    }

    let dest_dir = server.data_dir().join("sandbox-rootfs").join(&hex);
    let dest = dest_dir.join("rootfs.squashfs");
    if std::fs::metadata(&dest)
        .map(|m| m.len() > 0)
        .unwrap_or(false)
    {
        return Ok(hex);
    }
    let tmp = server
        .data_dir()
        .join(format!(".pull-d2-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&tmp).map_err(|e| {
        format!(
            "could not create the pull staging dir {}: {e}",
            tmp.display()
        )
    })?;
    let pulled = std::process::Command::new("oras")
        .args(["pull", "-o", &tmp.to_string_lossy(), &pinned])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    let sq = pulled
        .then(|| std::fs::read_dir(&tmp).ok())
        .flatten()
        .and_then(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .find(|p| p.extension().is_some_and(|x| x == "squashfs"))
        });
    let staged = match &sq {
        Some(sq) => {
            std::fs::create_dir_all(&dest_dir).ok();
            std::fs::rename(sq, &dest).is_ok()
        }
        None => false,
    };
    let _ = std::fs::remove_dir_all(&tmp);
    if staged {
        return Ok(hex);
    }
    Err(if !pulled {
        format!("`oras pull {pinned}` failed — the image resolves and verifies but could not be fetched")
    } else if sq.is_none() {
        format!("`oras pull {pinned}` produced no `.squashfs` layer")
    } else {
        format!(
            "could not move the pulled squashfs into this server's digest cache at {}",
            dest.display()
        )
    })
}

/// The rootfs content digest this server has staged + mounted, read off its own
/// isolated digest cache (`<data_dir>/sandbox-rootfs/<64hex>/rootfs.squashfs`).
/// This is the digest runs pin, so it is what a capsule's `environments.json`
/// declares and what `GET /sandbox/rootfs/{hex}` serves. `None` before any run.
pub fn mounted_env_digest(server: &TestServer) -> Option<String> {
    let base = server.data_dir().join("sandbox-rootfs");
    let mut found: Vec<String> = std::fs::read_dir(&base)
        .ok()?
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_str()?.to_string();
            let is_digest = name.len() == 64 && name.bytes().all(|b| b.is_ascii_hexdigit());
            let present = std::fs::metadata(e.path().join("rootfs.squashfs"))
                .map(|m| m.is_file() && m.len() > 0)
                .unwrap_or(false);
            (is_digest && present).then_some(name)
        })
        .collect();
    found.sort();
    // Several digests can be cached at once (a test may stage a second, historical
    // env image). The one that RAN is the one squashfuse actually mounted — its
    // `mnt/usr` is live. Prefer that; fall back to any cached digest.
    found
        .iter()
        .find(|d| base.join(d).join("mnt").join("usr").is_dir())
        .cloned()
        .or_else(|| found.last().cloned())
}

// ───────────────── the honest-skip ledger (machine-readable) ─────────────────
//
// WHY THIS EXISTS. libtest CAPTURES stdout/stderr for a test that PASSES, so a
// self-skip announced with `eprintln!` ALONE is byte-for-byte indistinguishable
// from a real pass in a default `cargo test` run:
//
//     cargo test … provenance::verify_test::real_sandbox_rerun_reproduces
//     → test result: ok. 1 passed; … finished in 0.00s      (zero skip text)
//
// The discipline every module header in this partition states — "a SKIP is
// recorded as SKIP, never a PASS" — therefore rested entirely on a human
// remembering `--nocapture` and transcribing by hand. That is exactly how a whole
// rootfs tier once reported "5 passed in 8.4 s" having executed nothing.
//
// So every gate below ALSO appends one `<test>\t<reason>` line to a LEDGER FILE,
// which survives capture and can be counted without `--nocapture`:
//
//     : > target/test-skip-ledger.tsv                     # before the run
//     cargo test -p txresbench --test integration_tests -- …
//     wc -l < target/test-skip-ledger.tsv                 # 0 ⇒ the tier really ran
//     cat    target/test-skip-ledger.tsv                  # which test, and why
//
//   * `TXR_TEST_SKIP_LEDGER=/abs/path.tsv` — write the ledger somewhere else
//     (a fresh path per run gives per-run counts without truncating).
//   * `TXR_TEST_NO_SKIP=1` — turn every gate into a hard FAILURE instead of a
//     skip. This is what an acceptance / CI tier runs, so a tier that executed
//     nothing CANNOT report green.

/// Where the self-skip ledger is written: `TXR_TEST_SKIP_LEDGER`, else
/// `<workspace>/target/test-skip-ledger.tsv`. Appended to, never truncated (the
/// suite runs many tests across threads and binaries) — clear it before a run.
pub fn skip_ledger_path() -> PathBuf {
    match std::env::var_os("TXR_TEST_SKIP_LEDGER") {
        Some(p) => PathBuf::from(p),
        // `CARGO_MANIFEST_DIR` = <workspace>/src-app/server.
        None => PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/test-skip-ledger.tsv"),
    }
}

/// Announce a self-skip on BOTH channels: the human `eprintln!` (visible only
/// under `--nocapture`) and the machine-readable ledger (survives libtest
/// capture, so a run's skips can be COUNTED). With `TXR_TEST_NO_SKIP=1` the gate
/// becomes a hard failure instead — the mode an acceptance tier runs in.
///
/// Call this from EVERY gate: a bare `eprintln!` skip is invisible by default and
/// reads as a PASS.
pub fn record_skip(test: &str, reason: &str) {
    let path = skip_ledger_path();
    eprintln!(
        "SKIP {test}: {reason} — self-skip, not the ignore attribute (also recorded in {})",
        path.display()
    );
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // O_APPEND: each line is one small `write(2)`, so concurrent test threads —
    // and concurrently-running test binaries — interleave lines, never bytes.
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        use std::io::Write;
        let one_line: String = reason
            .chars()
            .map(|c| {
                if c == '\t' || c == '\n' || c == '\r' {
                    ' '
                } else {
                    c
                }
            })
            .collect();
        let _ = writeln!(f, "{test}\t{one_line}");
    }
    if std::env::var("TXR_TEST_NO_SKIP").is_ok_and(|v| v == "1") {
        panic!(
            "SKIP {test}: {reason} — TXR_TEST_NO_SKIP=1 demands this tier ACTUALLY RUN, \
             so the skip is a hard failure"
        );
    }
}

/// Record the standard self-skip for a rootfs-gated test (via [`record_skip`], so
/// it lands in the ledger as well as on stderr).
pub fn skip_no_rootfs(test: &str) {
    record_skip(
        test,
        "no analysis rootfs is usable here — `GET /sandbox/status` is not ready, or the \
         `echo probe` execute failed. Point TXR_ENV_ROOTFS_SQUASHFS at a rootfs.squashfs \
         (or TXR_ENV_ROOTFS_DIR at a pre-mounted rootfs), or make the live OCI env-image \
         path reachable (`oras` + registry)",
    );
}

/// The SECOND gate every EXECUTABLE-capsule test needs: a capsule step runs only
/// inside the run's PINNED rootfs digest (`env_rootfs_sha256`), so a run recorded
/// WITHOUT one yields a `run.sh` that prints
/// "no pinned environment (not executed; provenance-only node)" for every step.
///
/// A digest is pinned by the live OCI path (`oras resolve` + cosign + pull) or by
/// the air-gap `TXR_ENV_ROOTFS_SQUASHFS` seam, which content-hashes the operator's
/// squashfs, stages it into the digest cache, and records that hash. It is NOT
/// pinned by a bare `TXR_ENV_ROOTFS_DIR` pre-mount (a mount dir has no content
/// identity) — on such a host the capsule tier genuinely cannot execute, so this
/// self-skips with the actionable fix named, never a false PASS and never the
/// compile-time ignore attribute. The skip is written to the SKIP LEDGER (see
/// [`record_skip`]) so it can be counted without `--nocapture`.
pub async fn pinned_env_digest(pool: &SqlitePool, run_id: Uuid, test: &str) -> Option<String> {
    let digest: Option<String> =
        sqlx::query_scalar("SELECT env_rootfs_sha256 FROM provenance_run_repro WHERE run_id = $1")
            .bind(run_id)
            .fetch_one(pool)
            .await
            .expect("the run's recorded env digest");
    match digest.filter(|d| !d.is_empty()) {
        Some(d) => {
            eprintln!("[capsule] run {run_id} pinned env rootfs digest {d}");
            Some(d)
        }
        None => {
            record_skip(
                test,
                "the run recorded NO pinned env rootfs digest, so no capsule step can execute on \
                 this host. Point TXR_ENV_ROOTFS_SQUASHFS at a rootfs.squashfs (it is \
                 content-hashed, staged into the digest cache and PINNED), or let the live OCI \
                 env-image path run",
            );
            None
        }
    }
}

// ───────────────── real analysis + executable capsule (rootfs-gated) ─────────

/// Submit a REAL analysis job (runs inside the mounted sandbox), wait for it to
/// complete, and return `(run_id, signature)` where `signature` = the sorted
/// `(output_id, content_hash)` the run cataloged. ONLY call under [`rootfs_gate`].
pub async fn run_real_analysis(
    server: &TestServer,
    token: &str,
    pool: &SqlitePool,
    project_id: Option<Uuid>,
    dataset_id: Option<Uuid>,
    name: &str,
    spec: Value,
) -> (Uuid, Vec<(String, String)>) {
    let mut body = json!({ "job_type": "analysis", "name": name, "params": spec });
    if let Some(s) = project_id {
        body["project_id"] = json!(s);
    }
    if let Some(d) = dataset_id {
        body["dataset_id"] = json!(d);
    }
    let resp = server
        .client
        .post(server.api_url("/jobs"))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .expect("submit analysis");
    assert_eq!(
        resp.status().as_u16(),
        201,
        "analysis job enqueued: {}",
        resp.status()
    );
    let job: Value = resp.json().await.unwrap();
    let id = Uuid::parse_str(job["id"].as_str().unwrap()).unwrap();
    let status = wait_terminal(pool, id, Duration::from_secs(300)).await;
    if status != "completed" {
        let jerr: Option<String> = sqlx::query_scalar("SELECT error FROM jobs WHERE id = $1")
            .bind(id)
            .fetch_one(pool)
            .await
            .ok()
            .flatten();
        let logs: Vec<(String, String)> = sqlx::query_as(
            "SELECT stream, content FROM job_logs WHERE job_id = $1 ORDER BY seq DESC LIMIT 50",
        )
        .bind(id)
        .fetch_all(pool)
        .await
        .unwrap_or_default();
        let logstr: String = logs
            .iter()
            .rev()
            .map(|(s, c)| format!("[{s}] {c}"))
            .collect::<Vec<_>>()
            .join("\n");
        panic!("the real analysis run completes — got status={status}\njob.error={jerr:?}\n--- last job logs ---\n{logstr}");
    }
    let sig: Vec<(String, String)> = sqlx::query_as(
        "SELECT output_id, content_hash FROM artifacts WHERE run_id = $1 ORDER BY output_id",
    )
    .bind(id)
    .fetch_all(pool)
    .await
    .expect("run signature");
    (id, sig)
}

/// Write zip members to disk under `dir`.
pub async fn extract_zip_to(members: &[(String, Vec<u8>)], dir: &Path) {
    for (name, bytes) in members {
        let p = dir.join(name);
        if let Some(parent) = p.parent() {
            tokio::fs::create_dir_all(parent).await.unwrap();
        }
        tokio::fs::write(&p, bytes).await.unwrap();
    }
}

/// Provision one env's rootfs squashfs from the running server's serve endpoint
/// (`GET /sandbox/rootfs/{hex}`) into the capsule at `env/<hex>/rootfs.squashfs`.
pub async fn obtain_squashfs(server: &TestServer, admin: &str, hex: &str, dest: &Path) -> bool {
    let resp = match server
        .client
        .get(server.api_url(&format!("/sandbox/rootfs/{hex}")))
        .bearer_auth(admin)
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        _ => return false,
    };
    let bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(_) => return false,
    };
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await.ok();
    }
    tokio::fs::write(dest, &bytes).await.is_ok()
}

/// Extract the capsule, provision each declared env's squashfs from the running
/// server's serve endpoint (so the `run.sh` execution itself is offline — the
/// "manually-placed squashfs, no network" path), and execute `run.sh`. Returns
/// `(capsule_dir, run_output)`.
pub async fn reproduce_capsule(
    server: &TestServer,
    admin: &str,
    zip: &[u8],
    tag: &str,
) -> (PathBuf, std::process::Output) {
    let members = unzip_store(zip);
    let dir = server
        .data_dir()
        .join(format!("capsule-{tag}-{}", Uuid::new_v4()));
    extract_zip_to(&members, &dir).await;

    // Provision every declared environment's squashfs from the server, up-front —
    // so run.sh needs no network of its own.
    if let Some((_, env_bytes)) = members.iter().find(|(n, _)| n == "environments.json") {
        if let Ok(env) = serde_json::from_slice::<Value>(env_bytes) {
            if let Some(arr) = env["environments"].as_array() {
                for e in arr {
                    if let Some(dig) = e["digest"].as_str() {
                        let hex = dig.strip_prefix("sha256:").unwrap_or(dig);
                        let dest = dir.join("env").join(hex).join("rootfs.squashfs");
                        obtain_squashfs(server, admin, hex, &dest).await;
                    }
                }
            }
        }
    }

    let output = tokio::time::timeout(
        Duration::from_secs(600),
        tokio::process::Command::new("bash")
            .arg("run.sh")
            .current_dir(&dir)
            .output(),
    )
    .await
    .expect("run.sh did not finish within 600s")
    .expect("spawn run.sh");
    (dir, output)
}

/// The sha256 hexes of every REGENERATED file in a run capsule — i.e. files the
/// steps produced under their `outputs/` dirs — EXCLUDING the seeded/static members
/// (`data/`, `.cas/`, `env/`, `scripts/`, and the fixed top-level files). A faithful
/// reproduction has each ORIGINAL output `content_hash` hex in this set.
pub fn capsule_regenerated_hashes(dir: &Path) -> std::collections::HashSet<String> {
    fn walk(dir: &Path, root: &Path, out: &mut std::collections::HashSet<String>) {
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in rd.flatten() {
            let p = entry.path();
            let rel = p
                .strip_prefix(root)
                .unwrap_or(&p)
                .to_string_lossy()
                .replace('\\', "/");
            if rel.starts_with("data/")
                || rel.starts_with(".cas/")
                || rel.starts_with("env/")
                || rel.starts_with("scripts/")
                || rel.starts_with(".shim-bin/")
            {
                continue;
            }
            if p.is_dir() {
                walk(&p, root, out);
            } else if p.is_file() {
                if let Ok(bytes) = std::fs::read(&p) {
                    out.insert(sha256_hex(&bytes));
                }
            }
        }
    }
    let mut set = std::collections::HashSet::new();
    // Only descend into step working dirs (where regenerated outputs live); the
    // top-level fixed files are static, so hashing them is harmless but skipped by
    // the prefix filter above for data/scripts/env.
    walk(dir, dir, &mut set);
    set
}

/// The content IDENTITY of every output the capsule's steps DECLARED, taken at the
/// same granularity the catalog records one.
///
/// [`capsule_regenerated_hashes`] hashes individual FILES, which is the identity of a
/// single-file artifact and of nothing else. An artifact that is a DIRECTORY is
/// identified by the merkle root over its members (`ingest::store_output` →
/// `merkle_root`), a value that is by construction not equal to any file's sha256 —
/// the capsule's own `verify_outputs.sh` says so in as many words and reports such an
/// output `unsupported`. So once outputs became directories, the per-file set could no
/// longer contain their recorded hashes at all, and every assertion resting on it
/// became unsatisfiable rather than strict.
///
/// The identity is computed by the server's OWN `content_hash_of_path` — the single
/// function that decides what a produced path's `content_hash` is — so this cannot
/// disagree with what ingest recorded for the original run. Re-deriving a merkle walk
/// here would be a second implementation of the very value under comparison.
///
/// Scope is the replay's own `outputs/manifest.json` (what the step SAID it produced),
/// so nothing is invented on the producer's behalf. A capsule whose steps write no
/// manifest yields an empty set and the per-file identities still apply.
pub async fn capsule_output_identities(dir: &Path) -> std::collections::HashSet<String> {
    use txresbench::modules::workstore::object_store::content_hash_of_path;

    let mut out = std::collections::HashSet::new();
    let work = dir.join("work");
    let Ok(rd) = std::fs::read_dir(&work) else {
        return out;
    };
    let mut step_dirs: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
    step_dirs.retain(|p| p.is_dir());
    step_dirs.sort();
    for step in step_dirs {
        let outputs = step.join("outputs");
        let Ok(bytes) = std::fs::read(outputs.join("manifest.json")) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        for entry in manifest["outputs"].as_array().into_iter().flatten() {
            let Some(rel) = entry["path"].as_str() else {
                continue;
            };
            let path = outputs.join(rel);
            if !path.exists() {
                continue;
            }
            if let Ok(id) = content_hash_of_path(&path).await {
                out.insert(id.strip_prefix("sha256:").unwrap_or(&id).to_string());
            }
        }
    }
    out
}

/// Assert every original output `content_hash` (`sha256:<hex>`) was regenerated by the
/// capsule — hash-for-hash, at the granularity the catalog recorded it.
///
/// The comparison set is the union of the per-FILE hashes and the per-OUTPUT content
/// identities ([`capsule_output_identities`]): a single-file artifact is found by
/// either, a directory artifact only by the second. The union widens WHERE the value
/// may be found, never WHICH value has to be found — a byte that differs still changes
/// the identity and still fails here.
pub async fn assert_reproduced(dir: &Path, signature: &[(String, String)]) {
    let mut regen = capsule_regenerated_hashes(dir);
    let n_files = regen.len();
    let identities = capsule_output_identities(dir).await;
    let n_declared = identities.len();
    regen.extend(identities);
    for (output_id, content_hash) in signature {
        let hex = content_hash.strip_prefix("sha256:").unwrap_or(content_hash);
        assert!(regen.contains(hex),
            "output {output_id} ({content_hash}) was NOT reproduced hash-for-hash (regenerated: {n_files} file hashes + {n_declared} declared-output identities)");
    }
}

/// Assert the capsule's `run.sh` really EXECUTED every step it announced, inside
/// the run's PINNED rootfs digest. Shared by every executable-capsule acceptance
/// test so the guard exists ONCE.
///
/// WHY NOT `assert!(!stdout.contains("no pinned environment"))` — the shape this
/// replaces, copy-pasted into two acceptance tests. That guard is an INVERTED
/// substring match on a producer message (`export/reproduce_script.rs::render_step`)
/// with no shared constant: reword the producer and the assertion becomes
/// permanently, silently TRUE, and both INV-1/INV-9 acceptance tests decay into
/// "the capsule exited 0" (a not-executed step exits 0 too).
///
/// So assert STRUCTURALLY and POSITIVELY instead, on facts no rewording can make
/// vacuous:
///   1. the capsule announced ≥ 1 step at all (`[step NN] …` on stdout);
///   2. EVERY announced step NAMED THE ROOTFS DIGEST IT RAN IN — a step that was
///      not executed, for ANY reason and under ANY wording, has no digest to name
///      (the producer only has one on the executed branch); and
///   3. at least one of those digests is the run's PINNED one.
///
/// Digests are matched as a bare 64-hex run, so a cosmetic reword of the executed
/// line (dropping the `sha256:` prefix, say) does not false-fail — but a step that
/// did not run still cannot satisfy it, which is the property that matters.
pub fn assert_capsule_steps_executed(stdout: &str, env_digest: &str, label: &str) {
    /// Does this line name a content digest (a run of ≥ 64 hex chars)?
    fn names_a_digest(line: &str) -> bool {
        let mut run = 0usize;
        for c in line.chars() {
            run = if c.is_ascii_hexdigit() { run + 1 } else { 0 };
            if run >= 64 {
                return true;
            }
        }
        false
    }

    let announced: Vec<&str> = stdout
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with("[step "))
        .collect();
    let executed: Vec<&str> = announced
        .iter()
        .copied()
        .filter(|l| names_a_digest(l))
        .collect();

    assert!(
        !announced.is_empty(),
        "[{label}] the capsule run.sh announced NO steps at all — it cannot have executed \
         anything\n--- stdout ---\n{stdout}"
    );
    assert_eq!(
        executed.len(),
        announced.len(),
        "[{label}] every announced capsule step must EXECUTE inside a rootfs (its line names the \
         digest it ran in); {} of {} named none — a step that is NOT executed exits 0, which is \
         exactly what must not read as a PASS\n--- announced ---\n{}\n--- stdout ---\n{stdout}",
        announced.len() - executed.len(),
        announced.len(),
        announced.join("\n"),
    );
    assert!(
        executed.iter().any(|l| l.contains(env_digest)),
        "[{label}] no capsule step ran in the run's PINNED rootfs {env_digest}\n--- announced ---\n\
         {}\n--- stdout ---\n{stdout}",
        announced.join("\n"),
    );
}

// The guard above is a pure function over the capsule's stdout, so its OWN
// non-vacuity is pinned here rather than by a one-off manual mutation. These are
// the cases that motivated replacing `assert!(!stdout.contains("no pinned
// environment"))`: under that shape, case (2) — a producer that reworded its
// not-executed message — passed silently.
#[cfg(test)]
mod capsule_steps_executed_tests {
    use super::assert_capsule_steps_executed;

    const D: &str = "0f1ec470cd8eeeb100a121ef3ed554702d332540561ec48da812eb210221d700";

    #[test]
    fn accepts_a_step_that_ran_in_the_pinned_rootfs() {
        let out = format!(
            "Reproduce runtime: squashfuse-bwrap\n\
             [step 00] running compute in sha256:{D} (x86_64)\n\
             Reproduce capsule complete.\n"
        );
        assert_capsule_steps_executed(&out, D, "ok");
    }

    #[test]
    fn tolerates_a_cosmetic_reword_that_still_names_the_digest() {
        let out = format!("[step 00] executing compute [{D}] (x86_64)\n");
        assert_capsule_steps_executed(&out, D, "reworded-but-executed");
    }

    #[test]
    #[should_panic(expected = "must EXECUTE inside a rootfs")]
    fn rejects_a_step_the_producer_declined_to_execute() {
        let out =
            "[step 00] compute — no pinned environment (not executed; provenance-only node)\n";
        assert_capsule_steps_executed(out, D, "unexecuted");
    }

    #[test]
    #[should_panic(expected = "must EXECUTE inside a rootfs")]
    fn rejects_an_unexecuted_step_under_a_REWORDED_message() {
        // The vacuity case: the inverted `!contains("no pinned environment")`
        // guard this replaced passed here, silently.
        let out = "[step 00] compute — environment not recorded; node skipped\n";
        assert_capsule_steps_executed(out, D, "reworded-unexecuted");
    }

    #[test]
    #[should_panic(expected = "announced NO steps at all")]
    fn rejects_a_capsule_that_announced_nothing() {
        assert_capsule_steps_executed("Reproduce capsule complete.\n", D, "empty");
    }

    #[test]
    #[should_panic(expected = "PINNED rootfs")]
    fn rejects_a_step_that_ran_in_some_OTHER_rootfs() {
        let out = format!(
            "[step 00] running compute in sha256:{} (x86_64)\n",
            "a".repeat(64)
        );
        assert_capsule_steps_executed(&out, D, "wrong-digest");
    }
}

// ─────────────────────────────── fixtures ───────────────────────────────

/// Absolute path to a fetch-on-demand fixture (see `fixtures/fetch.sh`). Returns
/// `Some(path)` only when the file is present + sha256-verified; `None` (offline /
/// not-fetched) → the caller self-skips.
pub fn fixture_path(name: &str, expected_sha256: &str) -> Option<PathBuf> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/dataset/fixtures")
        .join(name);
    let bytes = std::fs::read(&p).ok()?;
    if sha256_hex(&bytes) == expected_sha256 {
        Some(p)
    } else {
        eprintln!("fixture {name} present but sha256 mismatch — treating as absent");
        None
    }
}

// ───────────────────── real-processor product-path helpers ─────────────────────
// Promoted here from `processor_run_test.rs` so the provenance capsule-replay tier
// (TEST-EXPORT-REPLAY) drives the SAME product path + the SAME honest gate rather
// than a second copy. `processor_run_test.rs` picks these up via its existing
// `use super::hardening_common::*;`.

pub const PBMC3K: &str = "pbmc3k_raw.h5ad";
// Pinned in `fixtures/fetch.sh` (falexwolf.de mirror of the scanpy pbmc3k raw matrix).
pub const PBMC3K_SHA: &str = "89a96f1beaa2dd83a687666d3f19a4513ac27a2a2d12581fcd77afed7ea653a1";

/// Upload a real fixture file as a dataset; returns its `dataset_id`.
pub async fn upload_fixture(server: &TestServer, token: &str, name: &str, bytes: Vec<u8>) -> Uuid {
    use reqwest::multipart::{Form, Part};
    let form = Form::new().part("file", Part::bytes(bytes).file_name(name.to_string()));
    let resp = server
        .client
        .post(server.api_url("/datasets/upload"))
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await
        .expect("fixture upload");
    assert_eq!(resp.status().as_u16(), 200, "fixture upload succeeds");
    let body: Value = resp.json().await.expect("upload json");
    Uuid::parse_str(body["datasets"][0]["id"].as_str().expect("dataset id")).unwrap()
}

/// Run a processor on a dataset via the PRODUCT path and wait for the run. Returns
/// its output signature `[(output_id, content_hash)]` from the catalog — panicking
/// with the job error + tail logs if the run does not complete (so a real breakage
/// is loud, never a silent skip-as-pass).
pub async fn process_and_wait(
    server: &TestServer,
    token: &str,
    pool: &SqlitePool,
    dataset_id: Uuid,
    spec: Value,
) -> (Uuid, Vec<(String, String)>) {
    let resp = server
        .client
        .post(server.api_url(&format!("/datasets/{dataset_id}/process")))
        .bearer_auth(token)
        .json(&json!({ "spec": spec }))
        .send()
        .await
        .expect("process request");
    assert_eq!(
        resp.status().as_u16(),
        201,
        "process enqueues a job: {}",
        resp.status()
    );
    let job: Value = resp.json().await.expect("job json");
    let job_id = Uuid::parse_str(job["id"].as_str().unwrap()).unwrap();

    let status = wait_terminal(pool, job_id, Duration::from_secs(300)).await;
    if status != "completed" {
        let jerr: Option<String> = sqlx::query_scalar("SELECT error FROM jobs WHERE id = $1")
            .bind(job_id)
            .fetch_one(pool)
            .await
            .ok()
            .flatten();
        let logs: Vec<(String, String)> = sqlx::query_as(
            "SELECT stream, content FROM job_logs WHERE job_id = $1 ORDER BY seq DESC LIMIT 60",
        )
        .bind(job_id)
        .fetch_all(pool)
        .await
        .unwrap_or_default();
        let logstr: String = logs
            .iter()
            .rev()
            .map(|(s, c)| format!("[{s}] {c}"))
            .collect::<Vec<_>>()
            .join("\n");
        panic!("processor run completes — got status={status}\njob.error={jerr:?}\n--- last job logs ---\n{logstr}");
    }

    let run_id = job["run_id"]
        .as_str()
        .and_then(|s| Uuid::parse_str(s).ok())
        .unwrap_or(job_id);
    let sig: Vec<(String, String)> = sqlx::query_as(
        "SELECT output_id, content_hash FROM artifacts WHERE run_id = $1 ORDER BY output_id",
    )
    .bind(run_id)
    .fetch_all(pool)
    .await
    .expect("run signature");
    (run_id, sig)
}

/// Common gate: sandbox executable + fixture fetched. Returns the fixture bytes, or
/// `None` after logging a self-skip (never a false PASS).
pub async fn gate(server: &TestServer, admin: &str, test: &str) -> Option<Vec<u8>> {
    if rootfs_gate(server, admin).await.is_none() {
        skip_no_rootfs(test);
        return None;
    }
    match fixture_path(PBMC3K, PBMC3K_SHA) {
        Some(fx) => Some(std::fs::read(&fx).expect("read fixture")),
        None => {
            record_skip(
                test,
                &format!(
                    "{PBMC3K} not fetched or sha256-mismatched (run \
                     `bash tests/dataset/fixtures/fetch.sh pbmc3k`)"
                ),
            );
            None
        }
    }
}
