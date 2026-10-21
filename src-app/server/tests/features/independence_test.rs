//! TEST-3 [acceptance] [invariant: INV-3] — setting a per-account override does not
//! change the global default, and setting the global default does not change a
//! per-account override. Driven through the admin PUT API + the guard.

use cytoanalyst::modules::features::is_feature_enabled;
use uuid::Uuid;

use super::{account_body, features_put, global_body, DEMO_FLAG};
use crate::account::{pool_for, setup_admin};
use crate::common::TestServer;

#[tokio::test]
async fn global_and_per_account_are_independent() {
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

    // Set the GLOBAL default true.
    let (s, _) = features_put(&server, Some(&admin), DEMO_FLAG, global_body(true)).await;
    assert_eq!(s, 200, "global PUT ok");
    assert!(is_feature_enabled(&pool, DEMO_FLAG, None).await, "global is true");

    // Set a PER-ACCOUNT override false → the global default must stay true.
    let (s, _) = features_put(&server, Some(&admin), DEMO_FLAG, account_body(false, &account_s)).await;
    assert_eq!(s, 200, "per-account PUT ok");
    assert!(
        is_feature_enabled(&pool, DEMO_FLAG, None).await,
        "setting a per-account override must NOT change the global default"
    );
    assert!(
        !is_feature_enabled(&pool, DEMO_FLAG, Some(account)).await,
        "the per-account override applies to that account"
    );

    // Now flip the GLOBAL default to false → the per-account override must stay false
    // (unchanged), i.e. changing the global does not touch the override row.
    let (s, _) = features_put(&server, Some(&admin), DEMO_FLAG, global_body(false)).await;
    assert_eq!(s, 200, "global flip ok");
    assert!(
        !is_feature_enabled(&pool, DEMO_FLAG, Some(account)).await,
        "the per-account override survives a global change"
    );

    // And the reverse: flip the override to true → the global stays false.
    let (s, _) = features_put(&server, Some(&admin), DEMO_FLAG, account_body(true, &account_s)).await;
    assert_eq!(s, 200, "override flip ok");
    assert!(
        !is_feature_enabled(&pool, DEMO_FLAG, None).await,
        "flipping a per-account override must NOT change the global default"
    );
    assert!(
        is_feature_enabled(&pool, DEMO_FLAG, Some(account)).await,
        "the per-account override is now true for that account"
    );
}
