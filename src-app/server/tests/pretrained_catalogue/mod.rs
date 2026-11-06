//! The pretrained_catalogue integration suite — the ITEM-1/ITEM-2 file set
//! (TEST-PC-10/11/12/16/26 drivers) plus ITEM-5's route-landing suites
//! (`api_test.rs` — TEST-PC-21/22/27/31 — and `install_test.rs` —
//! TEST-PC-07/08). The downloader/install/catalogue/hygiene breadth suites
//! arrive with the items they cover.

use std::path::PathBuf;

use serde_json::{json, Value};

use crate::common::TestServer;

pub mod api_test;
pub mod gen_catalogue_test;
pub mod install_test;
pub mod pack_model_test;

/// The per-test pool (the same database the spawned server serves).
pub async fn pool(server: &TestServer) -> sqlx::SqlitePool {
    sqlx::SqlitePool::connect(server.database_url())
        .await
        .expect("per-test pool connects")
}

/// The repo root (`CARGO_MANIFEST_DIR` is `src-app/server`).
pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-app")
        .parent()
        .expect("repo root")
        .to_path_buf()
}

/// The fixture loopback server: binds 127.0.0.1:0, serves fixed bodies per
/// path (a catalogue document at `/catalogue.json`, asset bytes at
/// `/assets/<name>`), and RECORDS every request line (the INV-4-style
/// assertions read the actual request stream). Plain HTTP/1.1 — no
/// framework, no shared port. The request log + `stop` belong to the
/// hygiene suite (ITEM-6); the route suites use `catalogue_url`/`asset_url`
/// + drop.
#[allow(dead_code)]
pub struct FixtureHttpServer {
    pub port: u16,
    pub requests: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    task: tokio::task::JoinHandle<()>,
}

#[allow(dead_code)]
impl FixtureHttpServer {
    /// Serve the given catalogue bytes at `/catalogue.json` and the given
    /// asset bytes at `/assets/<file>` (as many names as provided).
    pub async fn spawn(catalogue: Vec<u8>, assets: Vec<(String, Vec<u8>)>) -> Self {
        use std::sync::Arc;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("loopback bind");
        let port = listener.local_addr().expect("addr").port();
        let requests: Arc<std::sync::Mutex<Vec<String>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let reqs = requests.clone();
        let task = tokio::spawn(async move {
            loop {
                let (mut stream, _) = match listener.accept().await {
                    Ok(v) => v,
                    Err(_) => return,
                };
                let mut buf = Vec::new();
                let mut tmp = [0u8; 1024];
                loop {
                    match stream.read(&mut tmp).await {
                        Ok(0) => break,
                        Ok(n) => {
                            buf.extend_from_slice(&tmp[..n]);
                            if buf.windows(4).any(|w| w == b"\r\n\r\n") || buf.len() > 64 * 1024 {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
                let head = String::from_utf8_lossy(&buf);
                reqs.lock().expect("request log")
                    .push(head.lines().next().unwrap_or("").to_string());
                // The response: the catalogue json at /catalogue.json, an
                // asset at /assets/<name>, 404 otherwise.
                let path = head
                    .lines()
                    .next()
                    .unwrap_or("")
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or("")
                    .to_string();
                let (status, body): (&str, &[u8]) = if path == "/catalogue.json" {
                    ("200 OK", catalogue.as_slice())
                } else if let Some(name) = path.strip_prefix("/assets/") {
                    match assets.iter().find(|(n, _)| n == name) {
                        Some((_, bytes)) => ("200 OK", bytes.as_slice()),
                        None => ("404 Not Found", b"not found"),
                    }
                } else {
                    ("404 Not Found", b"not found")
                };
                let mut out = format!(
                    "HTTP/1.1 {status}\r\ncontent-length: {}\r\ncontent-type: \
                     application/octet-stream\r\nconnection: close\r\n\r\n",
                    body.len()
                )
                .into_bytes();
                out.extend_from_slice(body);
                let _ = stream.write_all(&out).await;
                let _ = stream.shutdown().await;
            }
        });
        Self {
            port,
            requests,
            task,
        }
    }

    /// The fixture catalogue URL the spawned server's seams point at.
    pub fn catalogue_url(&self) -> String {
        format!("http://127.0.0.1:{}/catalogue.json", self.port)
    }

    /// An asset URL for the fixture server's `/assets/` path.
    pub fn asset_url(&self, file: &str) -> String {
        format!("http://127.0.0.1:{}/assets/{file}", self.port)
    }

    pub async fn stop(self) {
        self.task.abort();
        let _ = self.task.await;
    }
}

/// One fixture catalogue entry JSON (synthetic card facts; the exact
/// `models[]` shape the generator emits, so the server's live validation
/// accepts it — loopback asset URLs are the validator's own allowed set).
pub fn fixture_entry(
    id: &str,
    method_id: &str,
    min_draws: u32,
    needs_baseline: bool,
    url: &str,
    bundled: bool,
    size_bytes: u64,
    sha256: &str,
) -> Value {
    json!({
        "id": id,
        "version": "1.0.0",
        "kind": "published-rule",
        "name": format!("{id} synthetic rule"),
        "description": "Synthetic card facts — never real model, method or patient data.",
        "method_id": method_id,
        "method_version": "2.0.0",
        "group": "dynamic-risk",
        "group_label": "Dynamic risk",
        "paper": {"journal": "Synthetic Journal", "year": 2024, "doi": "10.0000/fx", "citation": "Synthetic et al. 2024."},
        "needs": {
            "marker_facts": {
                "kind": "single",
                "count": 1,
                "min_draws": min_draws,
                "needs_baseline": needs_baseline,
                "uses_history": "landmark",
                "needs_detection_call": false,
                "marker_groups_required": []
            },
            "required_markers": null,
            "covariates": "none",
            "decision_day": 56.0,
            "endpoint": "pfs",
            "horizon": 180.0,
            "task": "survival"
        },
        "env": {
            "base_digest": format!("sha256:{}", "aa".repeat(32)),
            "layer_digest": format!("sha256:{}", "bb".repeat(32))
        },
        "contract": "2.0",
        "embeds_training_data": false,
        "transfer": {"metric": "auc_rule", "median": 0.64, "n_cohorts": 1,
            "cohorts": [{"dataset": "fx-dataset-1", "value": 0.64}]},
        "assay_warnings": [{"code": "FX_WARN", "detail": "Synthetic assay warning"}],
        "research_notice": true,
        "licence": "CC0 1.0 (synthetic fixture)",
        "data_sources": [{"dataset": "fx-dataset-1", "access": "open", "licence": "CC0 1.0"}],
        "asset": {
            "bundled": bundled,
            "file": format!("{id}@1.0.0.txr"),
            "url": url,
            "size_bytes": size_bytes,
            "sha256": sha256,
            "signature": ""
        }
    })
}

/// A fixture catalogue document (schema-1, generated_from provenance) over
/// the given entry JSONs.
pub fn fixture_catalogue(entries: Vec<Value>) -> Value {
    json!({
        "schema_version": 1,
        "generated_from": {
            "registry_name": "fixtures (synthetic)",
            "registry_commit": "fixture",
            "models_repo": "tinnlab/txresbench-models",
            "generated_at": "2026-01-01T00:00:00Z"
        },
        "models": entries
    })
}

/// The file-inventory request the eligibility endpoints take (the provider's
/// one shape): 3 patients, one value marker M1, survival outcome columns
/// present. `per` is (patient, baseline, ontreatment) draw counts.
pub fn inventory_json(
    per: &[(&str, u32, u32)],
    decision_day: f64,
) -> Value {
    json!({
        "patients": per.len(),
        "decision_day": decision_day,
        "baseline_max_day": 0.0,
        "markers": [{
            "key": "M1",
            "display_name": "M1",
            "unit_family": "none",
            "standard_ids": [],
            "is_detection_call": false,
            "has_detection_companion": false,
            "n_patients_with_value": per.len(),
            "n_patients_with_baseline": per.iter().filter(|(_, b, _)| *b > 0).count(),
            "n_patients_with_ontreatment": per.iter().filter(|(_, _, o)| *o > 0).count(),
            "per_patient": per.iter().map(|(p, b, o)| json!({
                "patient_key": p, "baseline_draws": b, "ontreatment_draws": o
            })).collect::<Vec<_>>()
        }],
        "covariates": [],
        "outcomes": {"has_responder": false, "has_response_day": false,
            "has_event": true, "has_survival_day": true}
    })
}
