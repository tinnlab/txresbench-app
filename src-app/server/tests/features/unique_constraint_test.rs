//! TEST-5 [acceptance] [invariant: INV-5] — the unique constraint prevents duplicate
//! (flag, account) rows: repeated PUTs to the same pair UPDATE one row, never insert a
//! duplicate. Covers both the global (partial-unique) and per-account (composite)
//! write paths.

use uuid::Uuid;

use super::{account_body, features_put, global_body, DEMO_FLAG};
use crate::account::{pool_for, setup_admin};
use crate::common::TestServer;

async fn row_count(pool: &sqlx::SqlitePool, flag: &str, account: Option<Uuid>) -> i64 {
    match account {
        Some(a) => sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM feature_flags WHERE flag_key = $1 AND account_id = $2",
        )
        .bind(flag)
        .bind(a)
        .fetch_one(pool)
        .await
        .expect("count"),
        None => sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM feature_flags WHERE flag_key = $1 AND account_id IS NULL",
        )
        .bind(flag)
        .fetch_one(pool)
        .await
        .expect("count"),
    }
}

#[tokio::test]
async fn repeated_writes_update_one_row_not_duplicate() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let account: Uuid = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO accounts (kind, name) VALUES ('organization', 'acct') RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .expect("insert account");
    let account_s = account.to_string();

    // Two GLOBAL writes → exactly ONE global row (the second UPDATEs).
    for enabled in [true, false, true] {
        let (s, _) = features_put(&server, Some(&admin), DEMO_FLAG, global_body(enabled)).await;
        assert_eq!(s, 200);
    }
    assert_eq!(
        row_count(&pool, DEMO_FLAG, None).await,
        1,
        "repeated global PUTs must leave exactly one global row"
    );

    // Two PER-ACCOUNT writes to the same pair → exactly ONE per-account row.
    for enabled in [true, false] {
        let (s, _) = features_put(&server, Some(&admin), DEMO_FLAG, account_body(enabled, &account_s)).await;
        assert_eq!(s, 200);
    }
    assert_eq!(
        row_count(&pool, DEMO_FLAG, Some(account)).await,
        1,
        "repeated per-account PUTs to the same (flag, account) must leave exactly one row"
    );

    // The direct DB-level guard: a duplicate INSERT for the same pair is REJECTED.
    let dup = sqlx::query(
        "INSERT INTO feature_flags (flag_key, account_id, enabled) VALUES ($1, $2, true)",
    )
    .bind(DEMO_FLAG)
    .bind(account)
    .execute(&pool)
    .await;
    assert!(
        dup.is_err(),
        "a second row for the same (flag_key, account_id) must violate the unique index"
    );

    // And a duplicate GLOBAL row (account_id IS NULL) is rejected by the partial index.
    let dup_global = sqlx::query(
        "INSERT INTO feature_flags (flag_key, account_id, enabled) VALUES ($1, NULL, false)",
    )
    .bind(DEMO_FLAG)
    .execute(&pool)
    .await;
    assert!(
        dup_global.is_err(),
        "a second GLOBAL row for the same flag must violate the partial-unique index"
    );
}
