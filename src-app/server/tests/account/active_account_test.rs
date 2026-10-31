//! A4 acceptance tests — the ACTIVE-ACCOUNT invariants (INV-1/2/3):
//! - TEST-6 (INV-1): default = personal (no header → personal account; a project
//!   created with no header lands there).
//! - TEST-7 (INV-2): act under personal OR a member org (`X-Account-Id: O` stamps
//!   `account_id = O`; no header → personal).
//! - TEST-8 (INV-3): switch-to-non-member refused (a foreign `X-Account-Id` → 404,
//!   byte-identical to a nonexistent account id).

use serde_json::{json, Value};
use uuid::Uuid;

use crate::account::{create_user, login, make_org_account, pool_for, setup_admin};
use crate::common::TestServer;

/// The id of `user_id`'s personal account (the INV-1 default).
async fn personal_account_id(pool: &sqlx::SqlitePool, user_id: Uuid) -> Uuid {
    sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM accounts WHERE kind='personal' AND personal_user_id=$1",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await
    .expect("personal account exists")
}

/// The `account_id` a project was stamped with.
async fn project_account(pool: &sqlx::SqlitePool, project_id: Uuid) -> Uuid {
    sqlx::query_scalar::<_, Uuid>("SELECT account_id FROM projects WHERE id=$1")
        .bind(project_id)
        .fetch_one(pool)
        .await
        .expect("project account_id")
}

async fn create_project_with_account(
    server: &TestServer,
    token: &str,
    account: Option<Uuid>,
    name: &str,
) -> reqwest::Response {
    let mut req = server
        .client
        .post(server.api_url("/projects"))
        .bearer_auth(token)
        .json(&json!({ "name": name, "description": "" }));
    if let Some(a) = account {
        req = req.header("X-Account-Id", a.to_string());
    }
    req.send().await.expect("create project request")
}

// TEST-6 [acceptance][INV-1]: default = personal.
#[tokio::test]
async fn no_header_defaults_to_personal_account() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let alice_id = create_user(&server, &admin, "aa_alice", "aa_alice@cyto.test").await;
    let alice = login(&server, "aa_alice").await;
    let pool = pool_for(&server).await;

    let resp = create_project_with_account(&server, &alice, None, "no-header-project").await;
    assert_eq!(resp.status().as_u16(), 201, "create with no header → 201");
    let body: Value = resp.json().await.expect("project json");
    let project_id: Uuid = body["id"].as_str().unwrap().parse().unwrap();

    let personal = personal_account_id(&pool, alice_id).await;
    assert_eq!(
        project_account(&pool, project_id).await,
        personal,
        "a header-absent create lands in the personal account (INV-1)"
    );
}

// TEST-7 [acceptance][INV-2]: act under personal OR a member org.
#[tokio::test]
async fn member_acts_under_org_or_personal() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let alice_id = create_user(&server, &admin, "aa_m_alice", "aa_m_alice@cyto.test").await;
    let alice = login(&server, "aa_m_alice").await;
    let pool = pool_for(&server).await;

    let org = make_org_account(&pool, "alices-org", alice_id).await; // alice = owner member

    // Acting under the org (a member) → the project is stamped account_id = org.
    let resp = create_project_with_account(&server, &alice, Some(org), "org-project").await;
    assert_eq!(
        resp.status().as_u16(),
        201,
        "member creates under org → 201"
    );
    let body: Value = resp.json().await.expect("project json");
    let org_project: Uuid = body["id"].as_str().unwrap().parse().unwrap();
    assert_eq!(
        project_account(&pool, org_project).await,
        org,
        "acting under org O stamps account_id = O (INV-2)"
    );

    // The SAME user with no header still lands in their personal account.
    let resp = create_project_with_account(&server, &alice, None, "personal-project").await;
    let body: Value = resp.json().await.expect("project json 2");
    let personal_project: Uuid = body["id"].as_str().unwrap().parse().unwrap();
    let personal = personal_account_id(&pool, alice_id).await;
    assert_eq!(
        project_account(&pool, personal_project).await,
        personal,
        "no header → personal (the solo path is unchanged)"
    );
    assert_ne!(org, personal, "org and personal are distinct accounts");
}

/// The `account_id` a dataset was stamped with.
async fn dataset_account(pool: &sqlx::SqlitePool, dataset_id: Uuid) -> Uuid {
    sqlx::query_scalar::<_, Uuid>("SELECT account_id FROM datasets WHERE id=$1")
        .bind(dataset_id)
        .fetch_one(pool)
        .await
        .expect("dataset account_id")
}

// TEST-7 (dataset half — blind-audit coverage gap): a DATASET create under an org
// stamps `account_id = O`; no header → personal. Proves the dataset write path honors
// the active account (the upload wizard shares `create_in_account`).
#[tokio::test]
async fn dataset_create_stamps_active_account() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let alice_id = create_user(&server, &admin, "aa_ds_alice", "aa_ds_alice@cyto.test").await;
    let alice = login(&server, "aa_ds_alice").await;
    let pool = pool_for(&server).await;
    let org = make_org_account(&pool, "ds-org", alice_id).await;

    // Create a dataset acting under the org.
    let resp = server
        .client
        .post(server.api_url("/datasets"))
        .bearer_auth(&alice)
        .header("X-Account-Id", org.to_string())
        .json(&json!({ "name": "org-ds" }))
        .send()
        .await
        .expect("create dataset");
    assert_eq!(
        resp.status().as_u16(),
        201,
        "dataset create under org → 201"
    );
    let body: Value = resp.json().await.expect("dataset json");
    let ds_id: Uuid = body["id"].as_str().unwrap().parse().unwrap();
    assert_eq!(
        dataset_account(&pool, ds_id).await,
        org,
        "a dataset created under org O is stamped account_id = O (INV-2, dataset half)"
    );

    // No header → the personal account (behaviour-preserving).
    let resp = server
        .client
        .post(server.api_url("/datasets"))
        .bearer_auth(&alice)
        .json(&json!({ "name": "personal-ds" }))
        .send()
        .await
        .expect("create dataset 2");
    let body: Value = resp.json().await.expect("dataset json 2");
    let ds2: Uuid = body["id"].as_str().unwrap().parse().unwrap();
    let personal = personal_account_id(&pool, alice_id).await;
    assert_eq!(
        dataset_account(&pool, ds2).await,
        personal,
        "no header → personal (dataset)"
    );
}

// TEST-8 [acceptance][INV-3]: switch-to-non-member refused.
#[tokio::test]
async fn non_member_header_is_refused_with_404() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "aa_x_alice", "aa_x_alice@cyto.test").await;
    let alice = login(&server, "aa_x_alice").await;
    let bob_id = create_user(&server, &admin, "aa_x_bob", "aa_x_bob@cyto.test").await;
    let pool = pool_for(&server).await;

    // An org alice is NOT a member of.
    let foreign = make_org_account(&pool, "bobs-org", bob_id).await;
    let resp = create_project_with_account(&server, &alice, Some(foreign), "should-404").await;
    assert_eq!(
        resp.status().as_u16(),
        404,
        "a foreign X-Account-Id is refused with 404 (never 403, never a write) — INV-3"
    );

    // A wholly nonexistent account id → the SAME 404 (existence oracle).
    let resp =
        create_project_with_account(&server, &alice, Some(Uuid::new_v4()), "should-404-2").await;
    assert_eq!(
        resp.status().as_u16(),
        404,
        "a nonexistent account id is byte-identical to a non-member one (404)"
    );
}
