//! TEST-22 — `GET/PUT /provenance/settings` round-trip; out-of-bounds PUT → 422;
//! PUT invalidates the cache (read-back reflects it); non-admin PUT → 403; GET
//! unauth → 401.

use super::*;

async fn get_settings(server: &TestServer, token: &str) -> (u16, Value) {
    let resp = server
        .client
        .get(server.api_url("/provenance/settings"))
        .bearer_auth(token)
        .send()
        .await
        .expect("get settings");
    let status = resp.status().as_u16();
    let body = resp.json::<Value>().await.unwrap_or(Value::Null);
    (status, body)
}

#[tokio::test]
async fn settings_roundtrip_and_gates() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    // GET (admin) → 200 with the singleton row.
    let (status, body) = get_settings(&server, &admin).await;
    assert_eq!(status, 200, "admin GET settings is 200");
    assert!(body["export_retention_days"].is_number(), "settings shape present");

    // PUT (admin) a valid change → 200 reflecting it.
    let put = server
        .client
        .put(server.api_url("/provenance/settings"))
        .bearer_auth(&admin)
        .json(&json!({ "export_retention_days": 90 }))
        .send()
        .await
        .expect("put settings");
    assert_eq!(put.status().as_u16(), 200, "admin PUT is 200");
    let updated: Value = put.json().await.expect("put json");
    assert_eq!(updated["export_retention_days"], json!(90), "PUT reflects the change");

    // Read-back reflects the change (cache invalidation on PUT).
    let (_s, after) = get_settings(&server, &admin).await;
    assert_eq!(after["export_retention_days"], json!(90), "read-back reflects the write");

    // Out-of-bounds PUT → 422.
    let bad = server
        .client
        .put(server.api_url("/provenance/settings"))
        .bearer_auth(&admin)
        .json(&json!({ "export_retention_days": 99999 }))
        .send()
        .await
        .expect("put out-of-range");
    assert_eq!(bad.status().as_u16(), 422, "out-of-range is 422");

    // Non-admin PUT → 403 (settings::manage is admin-only, held via `*`).
    let member = create_user_without_provenance(&server, &admin, "settingsuser", "su@x.test").await;
    // (stripped Users member; even a full Users member lacks settings::manage —
    // stripping only removes the read/export grant, never a settings grant.)
    let deny = server
        .client
        .put(server.api_url("/provenance/settings"))
        .bearer_auth(&member)
        .json(&json!({ "export_retention_days": 10 }))
        .send()
        .await
        .expect("non-admin put");
    assert_eq!(deny.status().as_u16(), 403, "non-admin PUT settings is 403");

    // GET unauth → 401.
    let unauth = server
        .client
        .get(server.api_url("/provenance/settings"))
        .send()
        .await
        .expect("unauth get");
    assert_eq!(unauth.status().as_u16(), 401, "unauth GET settings is 401");
}

// TEST-7 [ITEM-1/2/3] — the promoted rootfs-GC knobs round-trip through GET/PUT, a partial
// PUT byte-preserves the untouched knob, and out-of-range values are refused (Rust 422).
#[tokio::test]
async fn gc_knobs_roundtrip_and_bounds() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    // GET exposes the new columns at their byte-preserving defaults.
    let (status, body) = get_settings(&server, &admin).await;
    assert_eq!(status, 200);
    assert_eq!(body["rootfs_gc_interval_secs"], json!(21600), "default interval = 6h");
    assert_eq!(body["rootfs_cache_max_digests"], json!(4), "default cap = 4");

    // Partial PUT of ONLY the cap: it changes; the interval is byte-preserved.
    let put = server
        .client
        .put(server.api_url("/provenance/settings"))
        .bearer_auth(&admin)
        .json(&json!({ "rootfs_cache_max_digests": 8 }))
        .send()
        .await
        .expect("put cap");
    assert_eq!(put.status().as_u16(), 200);
    let updated: Value = put.json().await.expect("put json");
    assert_eq!(updated["rootfs_cache_max_digests"], json!(8), "cap changed");
    assert_eq!(updated["rootfs_gc_interval_secs"], json!(21600), "interval byte-preserved");

    // Read-back reflects it (cache invalidation on PUT).
    let (_s, after) = get_settings(&server, &admin).await;
    assert_eq!(after["rootfs_cache_max_digests"], json!(8));

    // Out-of-range interval (below the 60s floor) → 422.
    let bad = server
        .client
        .put(server.api_url("/provenance/settings"))
        .bearer_auth(&admin)
        .json(&json!({ "rootfs_gc_interval_secs": 1 }))
        .send()
        .await
        .expect("put bad interval");
    assert_eq!(bad.status().as_u16(), 422, "sub-floor interval is 422");
    // Out-of-range cap (0) → 422.
    let bad2 = server
        .client
        .put(server.api_url("/provenance/settings"))
        .bearer_auth(&admin)
        .json(&json!({ "rootfs_cache_max_digests": 0 }))
        .send()
        .await
        .expect("put bad cap");
    assert_eq!(bad2.status().as_u16(), 422, "zero cap is 422");
}

// TEST-8 [acceptance][INV-4] — updated_by is stamped from the ACTING admin on every PUT and
// is not settable from the wire body.
#[tokio::test]
async fn updated_by_is_stamped_from_the_acting_admin() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let admin_id: Uuid = sqlx::query_scalar("SELECT id FROM users WHERE username = 'admin'")
        .fetch_one(&pool)
        .await
        .expect("admin id");

    // The seeded row has no updater yet.
    let (_s, before) = get_settings(&server, &admin).await;
    assert!(before["updated_by"].is_null(), "seeded row has no updated_by");

    // A PUT that even TRIES to set updated_by to a bogus uuid must not honor it.
    let bogus = Uuid::new_v4();
    let put = server
        .client
        .put(server.api_url("/provenance/settings"))
        .bearer_auth(&admin)
        .json(&json!({ "rootfs_cache_max_digests": 5, "updated_by": bogus }))
        .send()
        .await
        .expect("put");
    assert_eq!(put.status().as_u16(), 200);
    let updated: Value = put.json().await.expect("json");
    assert_eq!(
        updated["updated_by"].as_str().expect("updated_by set"),
        admin_id.to_string(),
        "updated_by is the acting admin, never the wire value"
    );
    assert_ne!(updated["updated_by"].as_str().unwrap(), bogus.to_string());
}

// TEST-9 [ITEM-1] — the DB CHECK is the second half of the double-bounds guard: a direct
// out-of-range UPDATE (bypassing the Rust validate()) is refused by Postgres.
#[tokio::test]
async fn db_check_rejects_out_of_range_gc_values() {
    let server = TestServer::spawn().await;
    let _admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let bad_interval = sqlx::query("UPDATE provenance_settings SET rootfs_gc_interval_secs = 5 WHERE id = TRUE")
        .execute(&pool)
        .await;
    assert!(bad_interval.is_err(), "DB CHECK rejects a sub-floor interval");

    let bad_cap = sqlx::query("UPDATE provenance_settings SET rootfs_cache_max_digests = 0 WHERE id = TRUE")
        .execute(&pool)
        .await;
    assert!(bad_cap.is_err(), "DB CHECK rejects a zero cap");

    let bad_cap_hi = sqlx::query("UPDATE provenance_settings SET rootfs_cache_max_digests = 100000 WHERE id = TRUE")
        .execute(&pool)
        .await;
    assert!(bad_cap_hi.is_err(), "DB CHECK rejects an over-ceiling cap");
}

// TEST-14 [acceptance][INV-1] — the legacy TXR_ROOTFS_CACHE_MAX_DIGESTS env var is a boot
// SEED, not a read-time override: it seeds the cap only while the row has never been
// admin-modified, and an admin PUT supersedes it for good — so an admin change to the cap is
// never silently inert (the phase-6 medium finding).
#[tokio::test]
async fn env_seed_seeds_only_until_an_admin_put() {
    use txresbench::modules::provenance::settings::ProvenanceSettingsRepository;

    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let repo = ProvenanceSettingsRepository::new(pool.clone());

    // Seeded row: never PUT (updated_by NULL), default cap 4.
    let (_s, before) = get_settings(&server, &admin).await;
    assert_eq!(before["rootfs_cache_max_digests"], json!(4));
    assert!(before["updated_by"].is_null());

    // The env seed lands on the un-modified row.
    repo.seed_rootfs_cap_from_env_if_unmodified(Some(2))
        .await
        .expect("seed");
    let seeded = repo.get().await.expect("get");
    assert_eq!(seeded.rootfs_cache_max_digests, 2, "env seeds the never-PUT row");
    assert!(seeded.updated_by.is_none(), "the seed does NOT stamp updated_by");

    // An admin PUT (stamps updated_by) makes the row authoritative.
    let put = server
        .client
        .put(server.api_url("/provenance/settings"))
        .bearer_auth(&admin)
        .json(&json!({ "rootfs_cache_max_digests": 9 }))
        .send()
        .await
        .expect("admin put");
    assert_eq!(put.status().as_u16(), 200);

    // A later env seed is now IGNORED — the admin value wins (env is never silently inert).
    repo.seed_rootfs_cap_from_env_if_unmodified(Some(2))
        .await
        .expect("second seed");
    let after = repo.get().await.expect("get after");
    assert_eq!(after.rootfs_cache_max_digests, 9, "admin PUT supersedes the env seed for good");
    assert!(after.updated_by.is_some(), "the row is admin-modified");
}
