//! TEST-PC-28 (the HTTP-surface half) + TEST-PC-22's unknown-id legs — the
//! download routes over the real spawned server: a REAL transfer from the
//! loopback fixture asset server (POST start → 202 `downloading` with the
//! polled byte counts → `ready` with the verified digest → the byte-exact
//! content-addressed cache file), the idempotent-rejoin arm, the typed 404s
//! for an unknown id on `POST`/`DELETE`, and the bundled source: a bundled
//! entry is NEVER downloaded (INV-8 — the bundle is the source; its status
//! is the ground truth) and its absent-file sibling stays `not_downloaded`
//! instead of dialing the asset URL.
//!
//! The state machine's deeper unit breadth (322 redirect, tampered body,
//! slow-chunk growth, concurrency cap, restart persistence) is the
//! in-module suite in `downloader.rs` (TEST-PC-05/06); this file pins the
//! routes that surface them.

use serde_json::Value;

use sha2::{Digest, Sha256};

use crate::common::{TestOptions, TestServer};

use super::*;

const FX_WIRE: &str = "fx-wire-001";

/// Serve a catalogue whose entry points at the fixture asset server's bytes,
/// spawn the server pointed at it, and return (server, fx, body, sha). The
/// entry's asset URL embeds the fixture server's bound port, so the
/// catalogue document is swapped in after the port exists (before the app
/// server boots — `set_catalogue`).
async fn wire_fixture() -> (TestServer, FixtureHttpServer, Vec<u8>, String) {
    let body: Vec<u8> = (0..2 * 1024 * 1024).map(|i| (i % 251) as u8).collect();
    let sha = hex::encode(Sha256::digest(&body));
    let fx = FixtureHttpServer::spawn(
        serde_json::to_vec(&fixture_catalogue(vec![])).expect("empty catalogue serializes"),
        vec![(format!("{FX_WIRE}@1.0.0.txr"), body.clone())],
    )
    .await;
    let catalogue = serde_json::to_vec(&fixture_catalogue(vec![fixture_entry(
        FX_WIRE,
        "cox-cutpoint-risk",
        1,
        false,
        &fx.asset_url(&format!("{FX_WIRE}@1.0.0.txr")),
        false,
        body.len() as u64,
        &sha,
    )]))
    .expect("fixture catalogue serializes");
    fx.set_catalogue(catalogue);
    let server = TestServer::spawn_with(TestOptions {
        catalogue_url: Some(fx.catalogue_url()),
        ..Default::default()
    })
    .await;
    (server, fx, body, sha)
}

/// Poll the downloads surface until the entry leaves `downloading` (or the
/// timeout fires).
async fn wait_downloads_terminal(
    server: &TestServer,
    token: &str,
    id: &str,
) -> Value {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        let resp = server
            .client
            .get(server.api_url("/txr/pretrained/downloads"))
            .bearer_auth(token)
            .send()
            .await
            .expect("downloads");
        assert_eq!(resp.status().as_u16(), 200);
        let body: Value = resp.json().await.expect("downloads json");
        let row = body["downloads"]
            .as_array()
            .expect("downloads array")
            .iter()
            .find(|d| d["id"] == id)
            .unwrap_or_else(|| panic!("{id} in the downloads list: {body}"))
            .clone();
        if row["state"] != "downloading" {
            return row;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "{id} stalls at byte {}/{:?}",
            row["bytes_downloaded"],
            row["bytes_total"]
        );
        tokio::time::sleep(std::time::Duration::from_millis(8)).await;
    }
}

/// TEST-PC-28 (HTTP surface): the route start → poll → ready chain — the
/// 202 carries the `downloading` state with the declared total, the polled
/// counts grow to the total, the terminal state is `ready` with the verified
/// digest, the byte-exact file sits at `<data_dir>/pretrained/cache/
/// <sha>.txr`, and a second POST while in flight joins the running transfer
/// (no second asset GET — the fixture's request log has exactly one line).
#[tokio::test]
async fn download_route_streams_verifies_and_caches() {
    let (server, fx, body, sha) = wire_fixture().await;
    let token = super::super::model_store::owner_token(&server).await;
    let resp = server
        .client
        .post(server.api_url("/txr/pretrained/refresh"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("refresh");
    assert_eq!(resp.status().as_u16(), 202);

    let resp = server
        .client
        .post(server.api_url(&format!("/txr/pretrained/{FX_WIRE}/download")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("start");
    assert_eq!(resp.status().as_u16(), 202, "start -> 202");
    let st: Value = resp.json().await.expect("start json");
    assert_eq!(st["id"], FX_WIRE);
    assert_eq!(st["state"], "downloading");
    assert_eq!(st["bytes_downloaded"], 0);
    assert_eq!(st["bytes_total"], body.len() as u64);

    // Idempotent rejoin while in flight.
    let resp = server
        .client
        .post(server.api_url(&format!("/txr/pretrained/{FX_WIRE}/download")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("start again");
    assert_eq!(resp.status().as_u16(), 202);

    let len = body.len() as u64;
    let mut last = 0u64;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        let resp = server
            .client
            .get(server.api_url("/txr/pretrained/downloads"))
            .bearer_auth(&token)
            .send()
            .await
            .expect("downloads");
        let body_v: Value = resp.json().await.expect("downloads json");
        let row = &body_v["downloads"][0];
        if row["state"] != "downloading" {
            break;
        }
        let bytes = row["bytes_downloaded"].as_u64().expect("bytes");
        assert!(bytes >= last, "the polled count is monotone");
        last = bytes;
        assert!(last <= len);
        assert!(
            std::time::Instant::now() < deadline,
            "the transfer stalls at {last}/{len}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(8)).await;
    }

    let row = wait_downloads_terminal(&server, &token, FX_WIRE).await;
    assert_eq!(row["state"], "ready", "{row}");
    assert_eq!(row["digest"], sha);
    assert_eq!(row["cached"], true);
    assert_eq!(row["bytes_downloaded"], len);
    assert!(row["error"].is_null());

    // The content-addressed cache holds the exact verified bytes.
    let cache = server.data_dir().join("pretrained/cache").join(format!("{sha}.txr"));
    assert!(cache.is_file(), "the verified file is cached");
    assert_eq!(std::fs::read(&cache).expect("read cache"), body);

    // Exactly one asset GET (the second POST joined the running transfer).
    let lines = fx.requests.lock().expect("request log").clone();
    let asset_gets: Vec<&String> = lines
        .iter()
        .filter(|l| l.starts_with("GET /assets/"))
        .collect();
    assert_eq!(asset_gets.len(), 1, "{lines:?}");

    // A completed start is idempotent: ready again, no new GET.
    let resp = server
        .client
        .post(server.api_url(&format!("/txr/pretrained/{FX_WIRE}/download")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("start ready");
    let st: Value = resp.json().await.expect("start ready json");
    assert_eq!(st["state"], "ready");
    assert_eq!(
        fx.requests
            .lock()
            .expect("request log")
            .iter()
            .filter(|l| l.starts_with("GET /assets/"))
            .count(),
        1,
        "a ready entry is never re-downloaded"
    );
    drop(fx);
}

/// TEST-PC-22's resource-leg 404s: an unknown id is `PRETRAINED_UNKNOWN` on
/// the download start and the cancel routes (the list/card/install 404s are
/// the api/install suites' legs).
#[tokio::test]
async fn unknown_id_is_404_on_the_download_surface() {
    let (server, fx, _body, _sha) = wire_fixture().await;
    let token = super::super::model_store::owner_token(&server).await;
    let resp = server
        .client
        .post(server.api_url("/txr/pretrained/no-such-model/download"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("start unknown");
    assert_eq!(resp.status().as_u16(), 404);
    assert_eq!(
        super::super::model_store::error_code(&resp.json().await.expect("body")),
        "PRETRAINED_UNKNOWN"
    );
    let resp = server
        .client
        .delete(server.api_url("/txr/pretrained/no-such-model/download"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("cancel unknown");
    assert_eq!(resp.status().as_u16(), 404);
    assert_eq!(
        super::super::model_store::error_code(&resp.json().await.expect("body")),
        "PRETRAINED_UNKNOWN"
    );
    drop(fx);
}

/// TEST-PC-23/28's bundled leg: a bundled entry whose verified file IS
/// present answers `ready` (bundled, offline) and is NEVER downloaded — the
/// asset server sees no GET; its sibling whose file is absent answers
/// `not_downloaded` (no verified form exists) instead of dialing the URL.
#[tokio::test]
async fn bundled_entry_is_never_downloaded() {
    let bundle: Vec<u8> = (0..4096).map(|i| (i % 113) as u8).collect();
    let sha = hex::encode(Sha256::digest(&bundle));
    let scratch = std::env::temp_dir().join(format!(
        "pc-bundled-route-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&scratch).expect("scratch");
    std::fs::write(scratch.join("fx-bundled-001@1.0.0.txr"), &bundle).expect("bundle bytes");

    let timer = FixtureHttpServer::spawn(
        serde_json::to_vec(&fixture_catalogue(vec![
            fixture_entry(
                "fx-bundled-001",
                "cox-cutpoint-risk",
                1,
                false,
                "http://127.0.0.1:1/assets/unused.txr",
                true,
                bundle.len() as u64,
                &sha,
            ),
            fixture_entry(
                "fx-bundled-002",
                "cox-cutpoint-risk",
                1,
                false,
                "http://127.0.0.1:1/assets/unused.txr",
                true,
                bundle.len() as u64,
                &sha,
            ),
        ]))
        .expect("fixture catalogue serializes"),
        vec![],
    )
    .await;
    let server = TestServer::spawn_with(TestOptions {
        catalogue_url: Some(timer.catalogue_url()),
        pretrained_bundled_dir: Some(scratch.clone()),
        ..Default::default()
    })
    .await;
    let token = super::super::model_store::owner_token(&server).await;
    let resp = server
        .client
        .post(server.api_url("/txr/pretrained/refresh"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("refresh");
    assert_eq!(resp.status().as_u16(), 202);

    // Present + verified: the bundle IS the status; no download starts.
    let resp = server
        .client
        .post(server.api_url("/txr/pretrained/fx-bundled-001/download"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("start bundled");
    assert_eq!(resp.status().as_u16(), 202);
    let st: Value = resp.json().await.expect("start bundled json");
    assert_eq!(st["state"], "ready", "{st}");
    assert_eq!(st["bundled"], true);
    assert_eq!(st["cached"], false, "the bundle is the source, never the cache");
    assert_eq!(st["digest"], sha);
    assert_eq!(
        timer
            .requests
            .lock()
            .expect("request log")
            .iter()
            .filter(|l| l.starts_with("GET /assets/"))
            .count(),
        0,
        "a bundled entry is never downloaded (INV-8)"
    );

    // Absent file: not_downloaded — the bundle is missing, and the route
    // surface never falls through to the URL (the install path does).
    let resp = server
        .client
        .post(server.api_url("/txr/pretrained/fx-bundled-002/download"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("start absent bundle");
    let st: Value = resp.json().await.expect("start absent bundle json");
    assert_eq!(st["state"], "not_downloaded", "{st}");
    assert_eq!(
        timer
            .requests
            .lock()
            .expect("request log")
            .iter()
            .filter(|l| l.starts_with("GET /assets/"))
            .count(),
        0,
        "the /download surface never dials an asset for a bundled entry"
    );

    let resp = server
        .client
        .get(server.api_url("/txr/pretrained/downloads"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("downloads");
    let body: Value = resp.json().await.expect("downloads json");
    let rows = body["downloads"].as_array().expect("downloads");
    assert_eq!(rows[0]["id"], "fx-bundled-001");
    assert_eq!(rows[0]["state"], "ready");
    assert_eq!(rows[0]["bundled"], true);
    assert_eq!(rows[1]["id"], "fx-bundled-002");
    assert_eq!(rows[1]["state"], "not_downloaded");
    drop((timer, server, scratch));
}
