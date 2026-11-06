//! TEST-PC-03 — the catalogue load + refresh chain (PROV-PC-5 / INV-8) over
//! the REAL spawned server: the boot-time refresh + the explicit refresh
//! return the origin actually in use (live → disk → embedded), the last-good
//! copy is written byte-exact, a dead live source degrades to the disk layer
//! and never fails boot, and a malformed live payload degrades the same way.
//! The spawned server resolves the catalogue URL through the
//! `CYTO_TXR_CATALOGUE_URL` seam (the documented env default resolution —
//! the only way a spawned process receives the constructor seams); the
//! fixture catalogue is served by the suite's loopback server.
//!
//! The deletion leg of the chain: a refresh with NO live source and NO disk
//! copy KEEPS the layer already in use (the ITEM-3 rule — a failed refresh
//! never downgrades the served catalogue), so the served origin stays `disk`;
//! the FRESH-BOOT `embedded` case (a brand-new runtime with no live and no
//! disk file — what the plan's "restart" phrasing means) is this suite's
//! `offline_boot_serves_the_embedded_snapshot` plus the unit suite's
//! `refresh_falls_back_live_disk_embedded`, which recreates the runtime.

use serde_json::Value;

use crate::common::{TestOptions, TestServer};

use super::*;

/// TEST-PC-03 (offline half): the default spawn points the boot refresh at a
/// closed loopback port — the refresh fails instantly, the runtime serves its
/// EMBEDDED snapshot, and the pretrained list is usable with the snapshot
/// entries (empty until the owner's publish pass — the valid empty state).
#[tokio::test]
async fn offline_boot_serves_the_embedded_snapshot() {
    let server = TestServer::spawn().await;
    let token = super::super::model_store::owner_token(&server).await;

    let resp = server
        .client
        .get(server.api_url("/txr/pretrained"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("list");
    assert_eq!(resp.status().as_u16(), 200);
    let body: Value = resp.json().await.expect("list json");
    assert_eq!(body["origin"], "embedded");
    assert_eq!(body["total"], 0, "the shipped snapshot has no entries yet");

    // The generated_at is the EMBEDDED file's provenance date — read the
    // committed snapshot and compare rather than pinning a literal date.
    let embedded: Value = serde_json::from_slice(&std::fs::read(
        repo_root().join("data/pretrained-catalogue/catalogue.json"),
    )
    .expect("read the embedded snapshot"))
    .expect("embedded snapshot parses");
    assert_eq!(
        body["generated_at"],
        embedded["generated_from"]["generated_at"],
        "the list serves the embedded layer's provenance date (INV-9)"
    );
}

/// TEST-PC-03 (the chain half): live → disk → embedded — with the fixture
/// catalogue server up, `POST /refresh` returns `origin: live` and writes the
/// last-good copy byte-exact; with the live server gone the refresh serves
/// `disk`; with the last-good file deleted it serves `embedded`. The served
/// rows follow the layer at every step, and a malformed live payload degrades
/// (never a boot failure).
#[tokio::test]
async fn refresh_chain_live_disk_embedded_over_the_served_inventory() {
    let catalogue_bytes = serde_json::to_vec(&fixture_catalogue(vec![
        fixture_entry(
            "fx-chain-001",
            "cox-cutpoint-risk",
            1,
            false,
            "http://127.0.0.1:1/assets/unused.txr",
            false,
            8,
            &"ab".repeat(32),
        ),
    ]))
    .expect("fixture catalogue serializes");
    let fx = FixtureHttpServer::spawn(catalogue_bytes.clone(), vec![]).await;
    let server = TestServer::spawn_with(TestOptions {
        catalogue_url: Some(fx.catalogue_url()),
        ..Default::default()
    })
    .await;
    let token = super::super::model_store::owner_token(&server).await;
    let last_good = server.data_dir().join("txr-pretrained/catalogue.json");

    // 1) Live: the explicit refresh elevates the runtime (the boot refresh
    // already pointed at the same server) and writes the last-good copy
    // byte-exact.
    let resp = server
        .client
        .post(server.api_url("/txr/pretrained/refresh"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("refresh");
    assert_eq!(resp.status().as_u16(), 202);
    let body: Value = resp.json().await.expect("refresh json");
    assert_eq!(body["origin"], "live", "{body}");
    assert_eq!(body["models"], 1);
    assert_eq!(body["cached_at"], "2026-01-01T00:00:00Z");
    assert!(last_good.is_file(), "the last-good copy is written");
    assert_eq!(
        std::fs::read(&last_good).expect("read last-good"),
        catalogue_bytes,
        "the last-good copy is byte-exact"
    );

    let resp = server
        .client
        .get(server.api_url("/txr/pretrained"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("list");
    let body: Value = resp.json().await.expect("list json");
    assert_eq!(body["origin"], "live");
    assert_eq!(body["models"][0]["id"], "fx-chain-001");

    // 2) Live gone, last-good present: the refresh degrades to disk.
    fx.stop().await;
    let resp = server
        .client
        .post(server.api_url("/txr/pretrained/refresh"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("refresh disk");
    assert_eq!(resp.status().as_u16(), 202);
    let body: Value = resp.json().await.expect("refresh disk json");
    assert_eq!(body["origin"], "disk", "{body}");
    assert_eq!(body["models"], 1);
    let resp = server
        .client
        .get(server.api_url("/txr/pretrained"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("list disk");
    let body: Value = resp.json().await.expect("list disk json");
    assert_eq!(body["origin"], "disk");
    assert_eq!(body["models"][0]["id"], "fx-chain-001");

    // 3) Last-good deleted: the refresh has no better layer to load AND no
    // worse one to drop to — the module keeps the layer already in use (the
    // ITEM-3 rule: a failed refresh never downgrades the served catalogue),
    // so the origin stays `disk`. The FRESH-BOOT embedded case (no live, no
    // disk file) is the offline-boot test above + the unit suite's
    // `refresh_falls_back_live_disk_embedded` (a new runtime is what a
    // restart is).
    std::fs::remove_file(&last_good).expect("remove last-good");
    let resp = server
        .client
        .post(server.api_url("/txr/pretrained/refresh"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("refresh after delete");
    assert_eq!(resp.status().as_u16(), 202);
    let body: Value = resp.json().await.expect("refresh after delete json");
    assert_eq!(body["origin"], "disk", "{body}");
    assert_eq!(body["models"], 1, "the kept layer still serves");
}

/// The malformed-live leg: a live catalogue that is not JSON degrades to the
/// embedded layer — the refresh answers with the degraded origin and the
/// server keeps serving (never a boot failure, DEC-16).
#[tokio::test]
async fn malformed_live_catalogue_degrades_without_failing_boot() {
    let fx = FixtureHttpServer::spawn(b"{ not json".to_vec(), vec![]).await;
    let server = TestServer::spawn_with(TestOptions {
        catalogue_url: Some(fx.catalogue_url()),
        ..Default::default()
    })
    .await;
    let token = super::super::model_store::owner_token(&server).await;

    let resp = server
        .client
        .get(server.api_url("/txr/pretrained"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("list");
    assert_eq!(resp.status().as_u16(), 200, "the server is up");
    let body: Value = resp.json().await.expect("list json");
    assert_eq!(body["origin"], "embedded");

    let resp = server
        .client
        .post(server.api_url("/txr/pretrained/refresh"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("refresh");
    assert_eq!(resp.status().as_u16(), 202);
    let body: Value = resp.json().await.expect("refresh json");
    assert_eq!(body["origin"], "embedded", "{body}");
    assert!(
        !server.data_dir().join("txr-pretrained/catalogue.json").exists(),
        "a malformed live payload never becomes the last-good copy"
    );
}
