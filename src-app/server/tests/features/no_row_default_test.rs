//! TEST-2 [acceptance] [invariant: INV-2] — a flag with NO row returns the compiled
//! default (never an error); an UNKNOWN flag fails closed (false).

use cytoanalyst::modules::features::is_feature_enabled;

use super::DEMO_FLAG;
use crate::account::pool_for;
use crate::common::TestServer;

#[tokio::test]
async fn no_row_returns_compiled_default_and_unknown_fails_closed() {
    let server = TestServer::spawn().await;
    let pool = pool_for(&server).await;

    // The table is seeded EMPTY, so DEMO_FLAG has no row — the guard must return its
    // COMPILED default (false) rather than erroring.
    assert!(
        !is_feature_enabled(&pool, DEMO_FLAG, None).await,
        "a registry flag with no row returns its compiled default (false)"
    );
    // Same for a per-account query with no rows.
    let account = uuid::Uuid::new_v4();
    sqlx::query("INSERT INTO accounts (id, kind, name) VALUES ($1, 'organization', 'acct')")
        .bind(account)
        .execute(&pool)
        .await
        .expect("insert account");
    assert!(
        !is_feature_enabled(&pool, DEMO_FLAG, Some(account)).await,
        "a registry flag with no per-account or global row returns its compiled default"
    );

    // An UNKNOWN flag (not in the registry) fails CLOSED — false, never an error/panic.
    assert!(
        !is_feature_enabled(&pool, "nope.not_a_flag", None).await,
        "an unknown flag key resolves to false (fail-closed), not an error"
    );
    assert!(
        !is_feature_enabled(&pool, "nope.not_a_flag", Some(account)).await,
        "an unknown flag key resolves to false for a per-account query too"
    );
}
