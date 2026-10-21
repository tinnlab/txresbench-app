//! A4 TEST-10 — ITEM-6's sync half: the `account_audience` per-recipient fan-out
//! (the A4-OWNED logic). Pins the audience resolution (owner ∪ the rest of the
//! members), exactly as the sibling `dataset_audience` is pinned by a direct test —
//! the fan-out DELIVERY leg is shared infrastructure (`fan_out_owner_scoped`, proven
//! by the dataset/project sync tests).
//!
//! Why not a cross-device SSE observation: the sole Phase-2 account mutation is the
//! auto-CREATION of a personal account, which A5's synchronous ensure (at
//! user-create) + the first-request backstop always complete BEFORE any browser /
//! probe can subscribe — so the one emit has no observer in Phase 2 (see DRIFT-1).
//! The emit IS wired on the runtime path (`ensure_personal_account_for` →
//! `publish_account_created`); this test pins the audience it fans to.

use cytoanalyst::modules::account::sync::account_audience;

use crate::account::{add_member, create_user, make_org_account, pool_for, setup_admin};
use crate::common::TestServer;

#[tokio::test]
async fn account_audience_is_owner_union_other_members() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let owner_id = create_user(&server, &admin, "aud_owner", "aud_owner@cyto.test").await;
    let m1 = create_user(&server, &admin, "aud_m1", "aud_m1@cyto.test").await;
    let m2 = create_user(&server, &admin, "aud_m2", "aud_m2@cyto.test").await;
    let pool = pool_for(&server).await;

    let org = make_org_account(&pool, "aud-org", owner_id).await; // owner = Owner member
    add_member(&pool, org, m1, "member").await;
    add_member(&pool, org, m2, "admin").await;

    let (owner, others) = account_audience(&pool, org)
        .await
        .expect("audience query ok")
        .expect("a populated account has an audience");
    assert_eq!(owner, owner_id, "the Owner-role member is the fan anchor");
    let mut got = others;
    got.sort();
    let mut want = vec![m1, m2];
    want.sort();
    assert_eq!(got, want, "every OTHER member is fanned to (per-recipient)");

    // A personal account fans to just its owner (the empty-recipient fan-to-self).
    let personal_owner = create_user(&server, &admin, "aud_solo", "aud_solo@cyto.test").await;
    let personal = sqlx::query_scalar::<_, uuid::Uuid>(
        "SELECT id FROM accounts WHERE kind='personal' AND personal_user_id=$1",
    )
    .bind(personal_owner)
    .fetch_one(&pool)
    .await
    .expect("personal account");
    let (owner, others) = account_audience(&pool, personal)
        .await
        .expect("audience ok")
        .expect("personal has an audience");
    assert_eq!(owner, personal_owner);
    assert!(others.is_empty(), "a personal account fans to self only");
}
