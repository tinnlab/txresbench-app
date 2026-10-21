//! TEST-1 [acceptance] [invariant: INV-1] — the guard resolves per-account override →
//! global default → compiled default, in that precedence order, with one fixture.

use cytoanalyst::modules::features::is_feature_enabled;
use uuid::Uuid;

use super::DEMO_FLAG;
use crate::account::pool_for;
use crate::common::TestServer;

async fn make_account(pool: &sqlx::PgPool, name: &str) -> Uuid {
    sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO accounts (kind, name) VALUES ('organization', $1) RETURNING id",
    )
    .bind(name)
    .fetch_one(pool)
    .await
    .expect("insert account")
}

async fn set_row(pool: &sqlx::PgPool, flag: &str, account: Option<Uuid>, enabled: bool) {
    sqlx::query("INSERT INTO feature_flags (flag_key, account_id, enabled) VALUES ($1, $2, $3)")
        .bind(flag)
        .bind(account)
        .bind(enabled)
        .execute(pool)
        .await
        .expect("insert flag row");
}

#[tokio::test]
async fn resolves_all_three_layers_in_precedence() {
    let server = TestServer::spawn().await;
    let pool = pool_for(&server).await;

    let account_a = make_account(&pool, "acct-a").await;
    let account_b = make_account(&pool, "acct-b").await;

    // Fixture: GLOBAL row = enabled(true); a PER-ACCOUNT override for A = disabled(false).
    // DEMO_FLAG's COMPILED default is false.
    set_row(&pool, DEMO_FLAG, None, true).await;
    set_row(&pool, DEMO_FLAG, Some(account_a), false).await;

    // Layer 1 (per-account override wins) for account A.
    assert!(
        !is_feature_enabled(&pool, DEMO_FLAG, Some(account_a)).await,
        "account A has an override=false; the per-account layer must win over the global true"
    );
    // Layer 2 (global) for account B — B has no override, so it falls to the global true.
    assert!(
        is_feature_enabled(&pool, DEMO_FLAG, Some(account_b)).await,
        "account B has no override; it must fall through to the global default (true)"
    );
    // Layer 2 (global) for the no-account (deployment-wide) query.
    assert!(
        is_feature_enabled(&pool, DEMO_FLAG, None).await,
        "no account queried; the global default (true) applies"
    );

    // Remove A's override → A now falls through to the global (true).
    sqlx::query("DELETE FROM feature_flags WHERE flag_key = $1 AND account_id = $2")
        .bind(DEMO_FLAG)
        .bind(account_a)
        .execute(&pool)
        .await
        .expect("delete override");
    assert!(
        is_feature_enabled(&pool, DEMO_FLAG, Some(account_a)).await,
        "with A's override gone, A falls through to the global default (true)"
    );

    // Remove the global row → Layer 3 (compiled default = false) applies to both.
    sqlx::query("DELETE FROM feature_flags WHERE flag_key = $1 AND account_id IS NULL")
        .bind(DEMO_FLAG)
        .execute(&pool)
        .await
        .expect("delete global");
    assert!(
        !is_feature_enabled(&pool, DEMO_FLAG, Some(account_a)).await,
        "no rows anywhere → the compiled default (false) applies per-account"
    );
    assert!(
        !is_feature_enabled(&pool, DEMO_FLAG, None).await,
        "no rows anywhere → the compiled default (false) applies globally"
    );
}
