//! #65 — abandon a verified migration + revert to the OLD store: the DB + local-fs data-integrity
//! core. Proves the no-data-loss guarantees that make abandon SAFE by construction:
//!  - INV-3: once a verified auto migration is marked `abandoned`, it is EXCLUDED from
//!    `latest_unretired`, so the config-change 409 is cleared (the store is reconfigurable) — while
//!    a still-`verified`/`failed` auto migration is NOT excluded (the block still protects the config);
//!  - INV-1/INV-4: the abandon core reverts the LIVE primary to the intact OLD store (atomic swap)
//!    and DELETES NOTHING — the old store keeps every blob AND the new store's copy is left in place;
//!  - INV-2: FAIL-CLOSED — when the OLD store cannot be reconstructed (undecryptable preserved
//!    config + no dual-read fallback), abandon REFUSES without swapping the primary or marking the row.
//!
//! `saas`-only (the whole cutover/abandon surface is). Needs a reachable Postgres (the shared build
//! cluster); no cloud-sim. The tests that touch the PROCESS-GLOBAL store handle are serialized by a
//! local lock (the global is shared across the test binary).

#![cfg(feature = "saas")]

use std::sync::Arc;

use txresbench::modules::workstore::cutover;
use txresbench::modules::workstore::migration_api;
use txresbench::modules::workstore::migration_repo::{self as repo, phase, NewMigration};
use txresbench::modules::workstore::object_store::{LocalFsStore, ObjectStore};
use txresbench::modules::workstore::{get_object_store, swap_object_store};
use uuid::Uuid;

use crate::account::pool_for;
use crate::common::{TestOptions, TestServer};

const STORAGE_KEY: &str = "migration-abandon-test-storage-key-0123456789ab";

/// Serializes the tests that touch the PROCESS-GLOBAL store handle — the global is shared across
/// the whole integration-test binary, so one test's swap must not be observed by another's.
static GLOBAL_HANDLE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn tmp() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("ws-abandon-{}", Uuid::new_v4()))
}
fn store(dir: &std::path::Path) -> Arc<dyn ObjectStore> {
    Arc::new(LocalFsStore::new(dir)) as Arc<dyn ObjectStore>
}

/// A LOCAL-source auto migration (the local→? config-switch shape): NULL preserved config
/// (rebuilt from the local root at boot), `auto_started` so it counts for `latest_unretired`.
fn local_auto_migration(dst_backend: &str) -> NewMigration {
    NewMigration {
        src_backend: "local".to_string(),
        src_provider: None,
        src_bucket: None,
        dst_backend: dst_backend.to_string(),
        dst_provider: Some("s3".to_string()),
        dst_bucket: Some("new-bucket".to_string()),
        cross_cloud: false,
        cost_ack: false,
        auto_started: true,
        blobs_total: 0,
        bytes_total: 0,
        src_config_ciphertext: None,
    }
}

/// TEST-1 [acceptance] [invariant: INV-3] — the 409-clearing lever: a verified auto migration
/// blocks a config change (`latest_unretired` returns it); once ABANDONED it is excluded (the block
/// is gone), while a `failed` auto migration is NOT excluded (a genuine failure keeps its OLD
/// fallback). Also proves the widened CHECK constraint accepts `abandoned` (ITEM-1) and that
/// `set_abandoned` is guarded to a `verified` row (ITEM-2).
#[tokio::test]
async fn abandon_clears_the_config_change_block_but_failed_does_not() {
    let server = TestServer::spawn_with(TestOptions {
        secret_storage_key: Some(STORAGE_KEY.to_string()),
        ..Default::default()
    })
    .await;
    let pool = pool_for(&server).await;
    let actor = Uuid::new_v4();

    // A verified auto migration BLOCKS a config change (this is exactly the #65 409 state).
    let row = repo::create(&pool, &local_auto_migration("s3"), actor).await.unwrap();
    repo::set_phase(&pool, row.id, phase::VERIFIED).await.unwrap();
    assert!(
        repo::latest_unretired(&pool).await.unwrap().is_some(),
        "a verified auto migration is un-retired ⇒ the config-change 409 fires"
    );

    // set_abandoned only affects a verified row (guard): a non-verified id is a no-op.
    let noop = repo::set_abandoned(&pool, Uuid::new_v4(), "no such row").await.unwrap();
    assert_eq!(noop, 0, "set_abandoned is a no-op on a non-verified/absent row");

    // Abandon it → the widened CHECK accepts 'abandoned', and it drops OUT of latest_unretired.
    let updated = repo::set_abandoned(&pool, row.id, "operator abandoned").await.unwrap();
    assert_eq!(updated, 1, "the verified row was marked abandoned");
    assert_eq!(repo::by_id(&pool, row.id).await.unwrap().unwrap().phase, "abandoned");
    assert!(
        repo::latest_unretired(&pool).await.unwrap().is_none(),
        "INV-3: an ABANDONED migration is excluded from latest_unretired ⇒ the 409 is cleared, the store is reconfigurable"
    );

    // Contrast: a FAILED auto migration is NOT excluded (it keeps its OLD dual-read fallback), so
    // reusing `failed` for abandon would NOT clear the block — the reason abandon needs its own phase.
    let failed = repo::create(&pool, &local_auto_migration("s3"), actor).await.unwrap();
    repo::set_failed(&pool, failed.id, "io error").await.unwrap();
    assert!(
        repo::latest_unretired(&pool).await.unwrap().is_some(),
        "a FAILED auto migration still blocks (keeps its OLD fallback) — abandon must NOT reuse 'failed'"
    );
}

/// TEST-2 [acceptance] [invariant: INV-1, INV-4] — the abandon core over local-fs reverts the LIVE
/// primary to the intact OLD store and DELETES NOTHING: after abandon the live handle IS old (reads
/// every OLD blob incl. an OLD-only write-window straggler), and BOTH stores keep exactly the blobs
/// they had (nothing deleted from old OR new — the new copy is left in place). Flip in a delete and
/// the count assertions go red.
#[tokio::test]
async fn abandon_reverts_the_live_primary_to_old_and_deletes_nothing() {
    let _guard = GLOBAL_HANDLE_LOCK.lock().await;
    let server = TestServer::spawn_with(TestOptions {
        secret_storage_key: Some(STORAGE_KEY.to_string()),
        ..Default::default()
    })
    .await;
    let pool = pool_for(&server).await;
    let actor = Uuid::new_v4();

    let (od, nd) = (tmp(), tmp());
    let old = store(&od);
    let new = store(&nd);

    // Pre-existing data + a copy pass OLD→NEW (verified), then an OLD-only write-window straggler.
    let mut pre = Vec::new();
    for i in 0..6u32 {
        pre.push(old.put(format!("pre-{i}").as_bytes()).await.unwrap());
    }
    cutover::catch_up(&old, &new).await.unwrap(); // OLD→NEW copy+verify (the migration copy pass)
    let straggler = old.put(b"old-only window straggler").await.unwrap();

    // Post-cutover LIVE state: the process-global handle is DualRead(new, old).
    cutover::install_dual_read(new.clone(), old.clone());
    assert!(get_object_store().as_dual_read().is_some(), "precondition: live handle is DualRead(new, old)");

    // A verified auto migration row (NULL preserved config ⇒ rebuilt from the local root; here the
    // abandon reaches OLD via the live dual-read fallback).
    let row0 = repo::create(&pool, &local_auto_migration("s3"), actor).await.unwrap();
    repo::set_phase(&pool, row0.id, phase::VERIFIED).await.unwrap();
    let row = repo::by_id(&pool, row0.id).await.unwrap().unwrap();

    // Snapshot the exact key sets right before abandon — the no-loss oracle.
    let old_before = old.list_keys().await.unwrap().len();
    let new_before = new.list_keys().await.unwrap().len();

    // INV-4 — concurrent readers hammer the LIVE handle THROUGH the abandon swap. A key present in
    // BOTH stores (a pre blob, copied to new) must read successfully on every snapshot, whether the
    // handle is still DualRead(new, old) or the swapped-in bare OLD — never a torn/empty handle.
    let probe = pre[0].clone();
    let mut readers = Vec::new();
    for _ in 0..6 {
        let probe = probe.clone();
        readers.push(tokio::spawn(async move {
            for _ in 0..300u32 {
                let s = get_object_store();
                s.get(&probe).await.expect("a concurrent read across the abandon swap never faults");
            }
        }));
    }

    // ABANDON (swaps the live handle while the readers are running).
    let outcome = migration_api::abandon_to_old(&pool, &row, actor).await.expect("abandon succeeds");
    assert_eq!(outcome.reverted_to, "local");
    for r in readers {
        r.await.unwrap();
    }

    // (a) the LIVE primary IS the old store now — every OLD blob is readable incl. the straggler.
    let live = get_object_store();
    assert!(live.as_dual_read().is_none(), "INV-4: the live handle was swapped back to the bare OLD store");
    assert_eq!(live.get(&straggler).await.unwrap(), b"old-only window straggler");
    for k in &pre {
        assert!(live.get(k).await.is_ok(), "every pre-existing OLD blob is still served after abandon");
    }

    // (b) NO blob deleted on EITHER side — old keeps everything, the new copy is left in place.
    assert_eq!(old.list_keys().await.unwrap().len(), old_before, "INV-1: NOT a single blob deleted from OLD");
    assert_eq!(new.list_keys().await.unwrap().len(), new_before, "INV-1: the NEW store's copy is left in place (nothing deleted from new)");

    // (c) the migration is abandoned ⇒ the config-change 409 is cleared.
    assert_eq!(repo::by_id(&pool, row.id).await.unwrap().unwrap().phase, "abandoned");
    assert!(repo::latest_unretired(&pool).await.unwrap().is_none(), "INV-3: reconfigurable after abandon");

    // Restore a clean global for any following test, then clean up.
    swap_object_store(store(&tmp()));
    let _ = std::fs::remove_dir_all(&od);
    let _ = std::fs::remove_dir_all(&nd);
}

/// TEST-3 [acceptance] [invariant: INV-2] — FAIL-CLOSED: a verified auto migration whose OLD store
/// cannot be reconstructed (a cloud source with NO preserved config to decrypt) AND whose live
/// handle is NOT a dual-read fallback is REFUSED — abandon does NOT swap the primary and does NOT
/// mark the row, so the primary is never left dangling and the 409 still protects the config.
#[tokio::test]
async fn abandon_fails_closed_when_the_old_store_is_unreconstructable() {
    let _guard = GLOBAL_HANDLE_LOCK.lock().await;
    let server = TestServer::spawn_with(TestOptions {
        secret_storage_key: Some(STORAGE_KEY.to_string()),
        ..Default::default()
    })
    .await;
    let pool = pool_for(&server).await;
    let actor = Uuid::new_v4();

    // The live handle is a BARE new store (NOT dual-read) — the abandon cannot reach OLD via a fallback.
    let nd = tmp();
    let bare_new = store(&nd);
    swap_object_store(bare_new.clone());

    // A verified auto migration with a CLOUD source but NO preserved config ciphertext ⇒
    // decrypt_preserved_old_config returns None ⇒ OLD is unreconstructable.
    let mut m = local_auto_migration("s3");
    m.src_backend = "s3".to_string();
    m.src_provider = Some("s3".to_string());
    m.src_bucket = Some("old-cloud-bucket".to_string());
    m.src_config_ciphertext = None; // a cloud source with no ciphertext ⇒ undecryptable
    let row0 = repo::create(&pool, &m, actor).await.unwrap();
    repo::set_phase(&pool, row0.id, phase::VERIFIED).await.unwrap();
    let row = repo::by_id(&pool, row0.id).await.unwrap().unwrap();

    let err = migration_api::abandon_to_old(&pool, &row, actor).await.expect_err("must fail closed");
    assert_eq!(err.error_code(), "ABANDON_OLD_STORE_UNAVAILABLE", "fail-closed with the right code: {err:?}");

    // The primary was NOT swapped (still the bare new store) and the row was NOT abandoned (still
    // verified ⇒ the 409 still protects the config).
    assert!(Arc::ptr_eq(&get_object_store(), &bare_new), "INV-2: the primary is untouched on a fail-closed refusal");
    assert_eq!(repo::by_id(&pool, row.id).await.unwrap().unwrap().phase, "verified", "the row stays verified");
    assert!(repo::latest_unretired(&pool).await.unwrap().is_some(), "the 409 still fires (not cleared by a refused abandon)");

    swap_object_store(store(&tmp()));
    let _ = std::fs::remove_dir_all(&nd);
}

/// TEST-4 [covers: ITEM-2, ITEM-3] — the endpoint eligibility guard-rails (`abandon_precheck`,
/// the exact checks the HTTP handler runs before touching any store): confirm:false ⇒ 400; no
/// migration ⇒ 404; a MANUAL verified migration ⇒ 422 (not applicable); a running (copying) auto
/// migration ⇒ 422 (not verified).
#[tokio::test]
async fn abandon_precheck_enforces_confirm_and_eligibility() {
    let server = TestServer::spawn_with(TestOptions {
        secret_storage_key: Some(STORAGE_KEY.to_string()),
        ..Default::default()
    })
    .await;
    let pool = pool_for(&server).await;
    let actor = Uuid::new_v4();

    // confirm:false ⇒ 400 ABANDON_NOT_CONFIRMED.
    let e = migration_api::abandon_precheck(&pool, false).await.expect_err("confirm required");
    assert_eq!(e.error_code(), "ABANDON_NOT_CONFIRMED");

    // no migration ⇒ 404.
    let e = migration_api::abandon_precheck(&pool, true).await.expect_err("no migration");
    assert!(e.to_string().to_lowercase().contains("migration") || e.error_code() == "NOT_FOUND", "404-ish: {e:?}");

    // a MANUAL verified migration ⇒ 422 ABANDON_NOT_APPLICABLE (it never advanced the config).
    let mut manual = local_auto_migration("s3");
    manual.auto_started = false;
    let mrow = repo::create(&pool, &manual, actor).await.unwrap();
    repo::set_phase(&pool, mrow.id, phase::VERIFIED).await.unwrap();
    let e = migration_api::abandon_precheck(&pool, true).await.expect_err("manual not applicable");
    assert_eq!(e.error_code(), "ABANDON_NOT_APPLICABLE");

    // a running (copying) AUTO migration ⇒ 422 ABANDON_NOT_VERIFIED (only a verified copy is abandonable).
    // (Retire the manual one first so `latest` is the new running row.)
    repo::set_phase(&pool, mrow.id, phase::RETIRED).await.unwrap();
    let arow = repo::create(&pool, &local_auto_migration("s3"), actor).await.unwrap();
    repo::set_phase(&pool, arow.id, phase::COPYING).await.unwrap();
    let e = migration_api::abandon_precheck(&pool, true).await.expect_err("copying not verified");
    assert_eq!(e.error_code(), "ABANDON_NOT_VERIFIED");
}
