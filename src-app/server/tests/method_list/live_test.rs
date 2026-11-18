//! The list in use over HTTP: the built-in copy offline, a verified newer list from the
//! (stand-in) registry, the stored copy at the next start, and a run that keeps the list it
//! started on when a newer one arrives.

use std::time::Duration;

use serde_json::{json, Value};
use sqlx::sqlite::SqlitePoolOptions;
use uuid::Uuid;

use super::{
    builtin_doc, fixture_pub, newer_list, oras_stub, publish, registry_calls, ADDED_METHOD,
    LOOPBACK_REF,
};
use crate::common::{TestOptions, TestServer};
use crate::execution_engine::{cohort_run_request, owner_token};

async fn get(server: &TestServer, token: &str, path: &str) -> Value {
    let resp = server
        .client
        .get(server.api_url(path))
        .bearer_auth(token)
        .send()
        .await
        .expect("GET");
    assert_eq!(resp.status().as_u16(), 200, "GET {path}");
    resp.json().await.expect("JSON")
}

async fn check_now(server: &TestServer, token: &str) -> Value {
    let resp = server
        .client
        .post(server.api_url("/methods/updates/check"))
        .bearer_auth(token)
        .send()
        .await
        .expect("POST check");
    assert_eq!(resp.status().as_u16(), 200);
    resp.json().await.expect("JSON")
}

fn builtin_sequence() -> u64 {
    builtin_doc()["sequence"].as_u64().expect("sequence")
}

fn served_options() -> TestOptions {
    TestOptions {
        method_list_ref: Some(LOOPBACK_REF.to_string()),
        method_list_test_key: Some(fixture_pub()),
        prestage_data_files: vec![oras_stub()],
        ..Default::default()
    }
}

#[tokio::test]
async fn boot_unreachable_registry_serves_builtin() {
    // The default harness reference is a CLOSED loopback port: the boot check and the
    // button's check fail, and the app serves its built-in list.
    let server = TestServer::spawn().await;
    let token = owner_token(&server).await;
    let status = check_now(&server, &token).await;
    assert_eq!(status["sequence"], builtin_sequence());
    assert_eq!(status["origin"], "builtin");
    assert_eq!(status["updates_enabled"], true);
    assert!(
        matches!(status["last_check"].as_str(), Some("unreachable" | "unavailable")),
        "{status}"
    );
    assert!(status["last_error"].is_string(), "a plain sentence: {status}");
    assert!(status["last_checked_at"].is_string());
    let list = get(&server, &token, "/methods").await;
    assert_eq!(list["method_list_sequence"], builtin_sequence());
    let ids: Vec<&str> = list["methods"].as_array().unwrap().iter().filter_map(|m| m["id"].as_str()).collect();
    assert!(!ids.contains(&ADDED_METHOD));
    // GET never asks the registry; it answers the last check.
    let again = get(&server, &token, "/methods/updates").await;
    assert_eq!(again["last_check"], status["last_check"]);
}

#[tokio::test]
async fn live_list_from_loopback_registry_verified_and_served() {
    let server = TestServer::spawn_with(served_options()).await;
    let token = owner_token(&server).await;
    let (list, sig, sequence) = newer_list(1, |_| {});
    publish(server.data_dir(), &list, &sig);
    let status = check_now(&server, &token).await;
    assert_eq!(status["last_check"], "updated", "{status}");
    assert_eq!(status["sequence"], sequence);
    assert_eq!(status["origin"], "live");
    assert!(status["signer"].as_str().unwrap().contains("TXR_METHOD_LIST_TEST_KEY"));

    // The new method is served, and the responses name the new list.
    let methods = get(&server, &token, "/methods").await;
    assert_eq!(methods["method_list_sequence"], sequence);
    assert!(methods["methods"]
        .as_array()
        .unwrap()
        .iter()
        .any(|m| m["id"] == ADDED_METHOD));
    let detail = get(&server, &token, &format!("/methods/{ADDED_METHOD}")).await;
    assert_eq!(detail["title"], "List update check");
    // eligibility_carries_list_sequence: the verdicts name the list they come from.
    let elig = server
        .client
        .post(server.api_url("/methods/eligibility"))
        .bearer_auth(&token)
        .json(&json!({"preview": {"marker_groups": {}}}))
        .send()
        .await
        .expect("eligibility");
    assert_eq!(elig.status().as_u16(), 200);
    let body: Value = elig.json().await.unwrap();
    assert_eq!(body["method_list_sequence"], sequence);
    assert!(body["methods"].as_array().unwrap().iter().any(|m| m["id"] == ADDED_METHOD));

    // The registry was asked for the moving tag, the artifact's manifest, then the list by
    // its digest.
    let calls = registry_calls(server.data_dir());
    assert!(calls.lines().any(|l| l.starts_with("manifest fetch")), "{calls}");
    let pull = calls.lines().find(|l| l.starts_with("pull")).expect("a pull");
    assert!(pull.contains("txresbench-method-list@sha256:"), "{pull}");
    assert!(pull.contains("--plain-http"), "a loopback registry: {pull}");
    // Stored for the next start.
    let stored = server.data_dir().join("method-list/v1/method-list.json");
    assert_eq!(std::fs::read(stored).expect("the last good copy"), list);

    // A list signed by nobody the app trusts is refused, the list in use stays.
    let (mut other, other_sig, _) = newer_list(2, |_| {});
    let at = other.len() / 2;
    other[at] = if other[at] == b' ' { b'\n' } else { b' ' };
    publish(server.data_dir(), &other, &other_sig);
    let refused = check_now(&server, &token).await;
    assert_eq!(refused["last_check"], "refused", "{refused}");
    assert_eq!(refused["sequence"], sequence);
}

#[tokio::test]
async fn restart_offline_uses_disk_copy() {
    // A previous session stored a verified list; this one starts offline (the harness's
    // closed port) and runs on the stored list.
    let (list, sig, sequence) = newer_list(1, |_| {});
    let server = TestServer::spawn_with(TestOptions {
        method_list_test_key: Some(fixture_pub()),
        prestage_data_files: vec![
            ("method-list/v1/method-list.json".to_string(), list, false),
            ("method-list/v1/method-list.json.minisig".to_string(), sig, false),
        ],
        ..Default::default()
    })
    .await;
    let token = owner_token(&server).await;
    let status = get(&server, &token, "/methods/updates").await;
    assert_eq!(status["sequence"], sequence, "{status}");
    assert_eq!(status["origin"], "disk");
    let methods = get(&server, &token, "/methods").await;
    assert!(methods["methods"].as_array().unwrap().iter().any(|m| m["id"] == ADDED_METHOD));

    // A stored copy that does not verify is ignored: the built-in list.
    let (list, mut sig, _) = newer_list(1, |_| {});
    let len = sig.len();
    sig[len - 5] = if sig[len - 5] == b'A' { b'B' } else { b'A' };
    let server = TestServer::spawn_with(TestOptions {
        method_list_test_key: Some(fixture_pub()),
        prestage_data_files: vec![
            ("method-list/v1/method-list.json".to_string(), list, false),
            ("method-list/v1/method-list.json.minisig".to_string(), sig, false),
        ],
        ..Default::default()
    })
    .await;
    let token = owner_token(&server).await;
    let status = get(&server, &token, "/methods/updates").await;
    assert_eq!((status["sequence"].as_u64(), status["origin"].as_str()), (Some(builtin_sequence()), Some("builtin")));
}

/// The run's method row for `method`.
async fn run_method(server: &TestServer, token: &str, run_id: &str, method: &str) -> Value {
    let run = get(server, token, &format!("/txr/runs/{run_id}")).await;
    run["methods"]
        .as_array()
        .expect("methods")
        .iter()
        .find(|m| m["method_id"] == method)
        .cloned()
        .unwrap_or_else(|| panic!("no {method} row: {run}"))
}

async fn wait_terminal(server: &TestServer, token: &str, run_id: &str) {
    for _ in 0..600 {
        let run = get(server, token, &format!("/txr/runs/{run_id}")).await;
        let status = run["run"]["status"].as_str().or(run["status"].as_str()).unwrap_or_default().to_string();
        if matches!(status.as_str(), "finished" | "failed" | "stopped") {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("run {run_id} did not finish");
}

async fn run_list_sequence(server: &TestServer, run_id: &str) -> Option<i64> {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect(server.database_url())
        .await
        .expect("the test DB");
    let id = Uuid::parse_str(run_id).expect("uuid");
    sqlx::query_scalar::<_, Option<i64>>("SELECT method_list_sequence FROM txr_runs WHERE id = ?")
        .bind(id)
        .fetch_one(&pool)
        .await
        .expect("the run row")
}

async fn create_run(server: &TestServer, token: &str, seen: Option<u64>) -> reqwest::Response {
    let mut req = cohort_run_request(&[METHOD], 1, false);
    req.method_list_sequence = seen;
    server
        .client
        .post(server.api_url("/txr/runs"))
        .bearer_auth(token)
        .json(&req)
        .send()
        .await
        .expect("POST /txr/runs")
}

const METHOD: &str = "ctdna-tf-four-group";

#[tokio::test]
async fn run_started_then_list_swapped_finishes_on_old_images() {
    let server = TestServer::spawn_with(served_options()).await;
    let token = owner_token(&server).await;
    // Env downloads through the stand-in are slow, then refused: the run is still going
    // when the newer list arrives.
    std::fs::create_dir_all(server.data_dir().join("registry")).unwrap();
    std::fs::write(server.data_dir().join("registry/env-delay"), b"3").unwrap();

    let start = builtin_sequence();
    let resp = create_run(&server, &token, Some(start)).await;
    assert_eq!(resp.status().as_u16(), 202, "a run on the built-in list");
    let r1: Value = resp.json().await.unwrap();
    let r1 = r1["id"].as_str().expect("run id").to_string();
    let r1_row = run_method(&server, &token, &r1, METHOD).await;

    // A newer list with another image for the run's method (another size and file).
    let (list, sig, sequence) = newer_list(1, |doc| {
        for e in doc["images"]["envs"].as_array_mut().unwrap() {
            if e["method_id"] == METHOD {
                e["size_bytes"] = (e["size_bytes"].as_u64().unwrap() + 4096).into();
            }
        }
    });
    publish(server.data_dir(), &list, &sig);
    let status = check_now(&server, &token).await;
    assert_eq!((status["last_check"].as_str(), status["sequence"].as_u64()), (Some("updated"), Some(sequence)));

    // The running run keeps the list it started on: its plan, its row, its sequence.
    wait_terminal(&server, &token, &r1).await;
    let r1_after = run_method(&server, &token, &r1, METHOD).await;
    assert_eq!(r1_after["bytes_total"], r1_row["bytes_total"], "the old image's size");
    assert_eq!(run_list_sequence(&server, &r1).await, Some(start as i64));

    // A screen still showing the old list cannot start a run.
    let stale = create_run(&server, &token, Some(start)).await;
    assert_eq!(stale.status().as_u16(), 409);
    let body: Value = stale.json().await.unwrap();
    assert!(body.to_string().contains("METHOD_LIST_CHANGED"), "{body}");

    // The next run is on the new list (its image, its sequence).
    let resp = create_run(&server, &token, Some(sequence)).await;
    assert_eq!(resp.status().as_u16(), 202);
    let r2: Value = resp.json().await.unwrap();
    let r2 = r2["id"].as_str().unwrap().to_string();
    assert_eq!(run_list_sequence(&server, &r2).await, Some(sequence as i64));
    let r2_row = run_method(&server, &token, &r2, METHOD).await;
    if let Some(old) = r1_row["bytes_total"].as_u64() {
        // This computer has the method's image (amd64): the new run plans the new file.
        assert_eq!(r2_row["bytes_total"].as_u64(), Some(old + 4096));
    }
    wait_terminal(&server, &token, &r2).await;
}
