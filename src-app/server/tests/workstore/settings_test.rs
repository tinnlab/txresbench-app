//! Workstore admin settings (issue #54) — the singleton GET/PUT + read-at-use.
//!
//!  * TEST-1 [acceptance INV-1] — a fresh (never-PUT) deployment GETs the
//!    BYTE-IDENTICAL compiled defaults.
//!  * TEST-3 [acceptance INV-4] — a PUT that lowers `max_output_file_bytes` takes
//!    effect at the INGEST use site with no restart (read-at-use): a file that
//!    ingested under the default cap is refused under the lowered one.
//!  * TEST-7 — a partial PUT persists + re-reads + stamps `updated_by`; an
//!    out-of-range PUT is a 422 (the safety bounds, DEC-3).
//!  * TEST-8 [A9] — a user lacking the permission gets 403 on GET and PUT; an
//!    unauthenticated request gets 401.

use std::path::{Path, PathBuf};

use serde_json::json;
use uuid::Uuid;

use cytoanalyst::modules::workstore::ingest::ingest_run_outputs;
use cytoanalyst::modules::workstore::settings::{
    UpdateWorkstoreSettings, WorkstoreSettings, WorkstoreSettingsRepository,
};
use cytoanalyst::modules::workstore::settings_cache;

use crate::account::{create_user_without_projects, login};
use crate::common::TestServer;

use super::{create_project, pool_for, server_store, setup_admin};

// TEST-1 [acceptance INV-1]: the default GET is byte-identical to the compiled consts.
#[tokio::test]
async fn get_settings_returns_byte_identical_defaults() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;

    let resp = server
        .client
        .get(server.api_url("/workstore/settings"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("GET settings");
    assert_eq!(resp.status().as_u16(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();

    // Each value equals the pre-existing compiled constant (INV-1).
    assert_eq!(body["gc_enabled"], json!(true));
    assert_eq!(body["gc_interval_hours"], json!(6));
    assert_eq!(body["gc_grace_secs"], json!(3600));
    assert_eq!(body["max_output_file_bytes"], json!(8_589_934_592i64)); // 8 GiB
    assert_eq!(body["max_multifile_total_bytes"], json!(34_359_738_368i64)); // 32 GiB
}

// TEST-7: a partial PUT persists + re-reads + stamps updated_by; out-of-range → 422.
#[tokio::test]
async fn put_settings_persists_stamps_updated_by_and_bounds_are_422() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;

    // Partial PUT — only the cadence changes.
    let resp = server
        .client
        .put(server.api_url("/workstore/settings"))
        .bearer_auth(&token)
        .json(&json!({ "gc_interval_hours": 12 }))
        .send()
        .await
        .expect("PUT settings");
    assert_eq!(resp.status().as_u16(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["gc_interval_hours"], json!(12), "sent field changed");
    assert_eq!(body["gc_enabled"], json!(true), "untouched field preserved");
    assert_eq!(body["max_output_file_bytes"], json!(8_589_934_592i64), "untouched field preserved");

    // Persisted: a fresh GET reflects it.
    let resp = server
        .client
        .get(server.api_url("/workstore/settings"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("GET settings");
    assert_eq!(resp.json::<serde_json::Value>().await.unwrap()["gc_interval_hours"], json!(12));

    // updated_by is stamped (audit column).
    let pool = pool_for(&server).await;
    let updated_by: Option<Uuid> =
        sqlx::query_scalar("SELECT updated_by FROM workstore_settings WHERE id = TRUE")
            .fetch_one(&pool)
            .await
            .expect("read updated_by");
    assert!(updated_by.is_some(), "PUT stamps updated_by");

    // Out-of-range → 422 (safety bounds, DEC-3): raise ABOVE the 64 GiB ceiling,
    // and drop the GC grace BELOW the 300s floor.
    for bad in [
        json!({ "max_output_file_bytes": 65i64 * 1024 * 1024 * 1024 }),
        json!({ "gc_grace_secs": 0 }),
    ] {
        let resp = server
            .client
            .put(server.api_url("/workstore/settings"))
            .bearer_auth(&token)
            .json(&bad)
            .send()
            .await
            .expect("PUT settings");
        assert_eq!(resp.status().as_u16(), 422, "out-of-range {bad} → 422");
    }
}

// TEST-8 [A9]: unauth → 401; a user lacking the permission → 403 on GET and PUT.
#[tokio::test]
async fn deny_path_401_unauth_and_403_without_permission() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    // No bearer → 401.
    let resp = server
        .client
        .get(server.api_url("/workstore/settings"))
        .send()
        .await
        .expect("GET settings");
    assert_eq!(resp.status().as_u16(), 401, "no bearer → 401");

    // A user without the admin `*` (and thus without workstore::settings::*) → 403.
    let _uid =
        create_user_without_projects(&server, &admin, "ws_set_np", "ws_set_np@cyto.test").await;
    let token = login(&server, "ws_set_np").await;

    let resp = server
        .client
        .get(server.api_url("/workstore/settings"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("GET settings");
    assert_eq!(resp.status().as_u16(), 403, "missing workstore::settings::read → 403");

    let resp = server
        .client
        .put(server.api_url("/workstore/settings"))
        .bearer_auth(&token)
        .json(&json!({ "gc_interval_hours": 12 }))
        .send()
        .await
        .expect("PUT settings");
    assert_eq!(resp.status().as_u16(), 403, "missing workstore::settings::manage → 403");
}

/// Build a staging dir with ONE single-file opaque output of `size` bytes.
async fn staging_with_output(server: &TestServer, size: usize) -> PathBuf {
    let ws = server.data_dir().join(format!("staging-{}", Uuid::new_v4()));
    let outputs = ws.join("outputs");
    tokio::fs::create_dir_all(&outputs).await.unwrap();
    let manifest = json!({ "outputs": [
        { "id": "big", "datatype": "data/opaque", "path": "big.bin", "layout": "opaque",
          "structure": {"encoding":"opaque","media_type":"application/octet-stream"},
          "meta": {}, "role": "artifact" }
    ]});
    tokio::fs::write(outputs.join("manifest.json"), manifest.to_string())
        .await
        .unwrap();
    tokio::fs::write(outputs.join("big.bin"), vec![0u8; size])
        .await
        .unwrap();
    ws
}

// TEST-3 [acceptance INV-4]: read-at-use — a PUT that lowers max_output_file_bytes
// takes effect at the INGEST site with no restart. The SAME 2 MiB output that
// ingests fine under the default cap is refused OUTPUT_TOO_LARGE under a lowered cap.
#[tokio::test]
async fn ingest_cap_is_read_at_use_after_a_settings_change() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "ws readatuse").await;
    let pool = pool_for(&server).await;
    let store = server_store(&server);

    const TWO_MIB: usize = 2 * 1024 * 1024;

    // POSITIVE CONTROL: under the default cap (8 GiB) a 2 MiB output ingests fine.
    // Pin the in-process read-at-use cache to the defaults for this assertion.
    settings_cache::invalidate(WorkstoreSettings::defaults());
    let ws_ok = staging_with_output(&server, TWO_MIB).await;
    let run_ok = Uuid::new_v4();
    ingest_run_outputs(&pool, &store, Some(project), None, run_ok, None, Path::new(&ws_ok))
        .await
        .expect("2 MiB ingests under the default 8 GiB cap");

    // LOWER the cap to its floor (1 MiB) via the repository, then refresh the
    // read-at-use cache exactly as the PUT handler does.
    let repo = WorkstoreSettingsRepository::new(pool.clone());
    let lowered = repo
        .update(
            &UpdateWorkstoreSettings { max_output_file_bytes: Some(1024 * 1024), ..Default::default() },
            Uuid::new_v4(),
        )
        .await
        .expect("lower the cap");
    settings_cache::invalidate(lowered);

    // The SAME 2 MiB output now exceeds the lowered cap — refused at the use site
    // WITHOUT a server restart (read-at-use, INV-4).
    let ws_big = staging_with_output(&server, TWO_MIB).await;
    let run_big = Uuid::new_v4();
    let err = ingest_run_outputs(&pool, &store, Some(project), None, run_big, None, Path::new(&ws_big))
        .await
        .expect_err("2 MiB now exceeds the lowered 1 MiB cap");
    assert_eq!(err.error_code(), "OUTPUT_TOO_LARGE");

    // Restore defaults so sibling tests in this binary see a clean cache.
    settings_cache::invalidate(WorkstoreSettings::defaults());
}

// TEST-16 [covers ITEM-6 / DEC-8]: byte-preservation for env-configured deployments.
// The legacy GC env seed applies to the singleton WHILE it is unmodified
// (`updated_by IS NULL`) and is SUPERSEDED (ignored) once an admin PUTs — so a
// deployment that tuned GC via env and never PUTs stays byte-identical (INV-1),
// while an admin's choice wins for good. This is the real proof of the INV-1
// "byte-identical for env-configured deployments" claim (not a tautology).
#[tokio::test]
async fn env_seed_applies_while_unmodified_then_superseded_by_a_put() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let repo = WorkstoreSettingsRepository::new(pool.clone());

    // A never-modified row (updated_by IS NULL) accepts the env seed.
    repo.seed_from_env_if_unmodified(&UpdateWorkstoreSettings {
        gc_enabled: Some(false),
        gc_interval_hours: Some(3),
        ..Default::default()
    })
    .await
    .expect("env seed while unmodified");
    let after_seed = repo.get().await.unwrap();
    assert!(!after_seed.gc_enabled, "env seed disabled GC on a fresh row");
    assert_eq!(after_seed.gc_interval_hours, 3, "env seed set the cadence");

    // An admin PUT stamps updated_by → env can no longer override.
    let resp = server
        .client
        .put(server.api_url("/workstore/settings"))
        .bearer_auth(&token)
        .json(&json!({ "gc_interval_hours": 24 }))
        .send()
        .await
        .expect("PUT settings");
    assert_eq!(resp.status().as_u16(), 200);

    // A subsequent boot-style env seed is now IGNORED (updated_by IS NOT NULL).
    repo.seed_from_env_if_unmodified(&UpdateWorkstoreSettings {
        gc_enabled: Some(true),
        gc_interval_hours: Some(6),
        ..Default::default()
    })
    .await
    .expect("env seed after admin PUT");
    let after_put = repo.get().await.unwrap();
    assert_eq!(after_put.gc_interval_hours, 24, "an admin PUT supersedes env for good");
}

// ---------------------------------------------------------------------------
// uncapped-uploads TEST-16 [covers: ITEM-1, ITEM-3]
// ---------------------------------------------------------------------------

/// uncapped-uploads TEST-16 — the two promoted upload ceilings really exist in a
/// freshly migrated database, at the compiled defaults, and are still bounded.
///
/// This is the only test of migration `202609020010_upload_limits.sql`. It was
/// enumerated in TESTS.md but never written, so the migration's column defaults and
/// its CHECK bounds were entirely unexercised: the row could have defaulted to
/// anything, or carried bounds that disagreed with `validate()`, with every test
/// green.
///
/// The 422 leg matters for INV-4 specifically. `validate()` and the DB CHECK are two
/// independent copies of the same bounds, and a value that `validate()` accepts but
/// the CHECK rejects is a 500 rather than a 422 — so asserting the *code* is what
/// proves the two agree rather than merely that something refused.
#[tokio::test]
async fn uncapped_uploads_test16_upload_ceilings_are_seeded_and_bounded() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;

    let resp = server
        .client
        .get(server.api_url("/workstore/settings"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("GET settings");
    assert_eq!(resp.status().as_u16(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();

    // The seeded default equals the retired `UPLOAD_BODY_LIMIT` const, so a SaaS
    // deployment that has never PUT the row keeps exactly the ceiling it always had
    // (INV-3: a misconfigured deployment degrades to its old ceiling, not to
    // "unlimited").
    assert_eq!(body["max_upload_body_bytes"], json!(68_719_476_736i64)); // 64 GiB
    assert_eq!(body["max_upload_parts"], json!(1024));

    // Both are still bounded — an admin cannot raise either to unbounded (INV-4).
    for (field, value) in [
        ("max_upload_body_bytes", json!(257i64 * 1024 * 1024 * 1024)), // > 256 GiB
        ("max_upload_parts", json!(65_537)),                           // > 65536
    ] {
        let resp = server
            .client
            .put(server.api_url("/workstore/settings"))
            .bearer_auth(&token)
            .json(&json!({ field: value }))
            .send()
            .await
            .expect("PUT settings");
        assert_eq!(resp.status().as_u16(), 422, "{field} past its range is refused");
        let err: serde_json::Value = resp.json().await.expect("422 body");
        assert_eq!(
            err["error_code"],
            json!("WORKSTORE_SETTING_OUT_OF_RANGE"),
            "refused by validate() with a typed 422, not by the DB CHECK with a 500 — \
             which is what proves the two copies of the bounds agree: {err}"
        );
    }

    // A partial PUT of one ceiling leaves the other, and the five pre-existing knobs,
    // untouched (the COALESCE update + merge semantics).
    let resp = server
        .client
        .put(server.api_url("/workstore/settings"))
        .bearer_auth(&token)
        .json(&json!({ "max_upload_parts": 2048 }))
        .send()
        .await
        .expect("PUT settings");
    assert_eq!(resp.status().as_u16(), 200);
    let after: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(after["max_upload_parts"], json!(2048), "the named field moved");
    assert_eq!(
        after["max_upload_body_bytes"],
        json!(68_719_476_736i64),
        "the unnamed ceiling did NOT move"
    );
    assert_eq!(after["max_output_file_bytes"], json!(8_589_934_592i64), "pre-existing knob intact");
    assert_eq!(after["gc_interval_hours"], json!(6), "pre-existing knob intact");
}
