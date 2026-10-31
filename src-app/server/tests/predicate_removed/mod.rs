//! TEST-21 (ITEM-4) — the predicate module is UNREGISTERED, not merely permission-denied.
//!
//! ITEM-4 scrapped the predicate DSL: `server/src/modules/predicate/` and its three routes
//! are deleted, along with the `predicate_settings` sync entity and the two
//! `predicate::settings::{read,manage}` permissions.
//!
//! The distinction that matters is 404 vs 403. A 403 would mean the routes are still
//! MOUNTED and merely unreachable for want of a permission — the module would still be
//! compiled in, still holding its handlers, and one permission grant away from being live
//! again. Only a 404 proves the router never learned about them. So the assertion is on
//! the exact status, in both directions:
//!
//!   * with the FIRST-RUN ADMIN token (which holds the `*` wildcard, so no permission can
//!     be the reason) — a mounted route would answer 200/400/405, never 404;
//!   * with NO token at all — a mounted route behind `RequirePermissions` answers 401
//!     before it ever looks at the path.
//!
//! Every case carries a positive control on a SURVIVING route through the same client, so
//! "everything 404s" (a server that failed to mount anything) cannot read as success.

use serde_json::{json, Value};

use crate::common::TestServer;

/// The three routes ITEM-4 deleted, with the method each was served under.
const DELETED: &[(&str, &str)] = &[
    ("POST", "/selection/by-predicate"),
    ("GET", "/predicate/vocabulary"),
    ("GET", "/predicate/settings"),
    ("PUT", "/predicate/settings"),
];

async fn setup_admin(server: &TestServer) -> String {
    let resp = server
        .client
        .post(server.api_url("/session/local"))
        .json(&json!({
            "username": "admin",
            "email": "admin@cyto.test",
            "password": "adminPassw0rd!",
            "display_name": "Admin"
        }))
        .send()
        .await
        .expect("setup/admin");
    assert_eq!(resp.status().as_u16(), 200, "setup/admin creates the owner");
    let body: Value = resp.json().await.expect("setup json");
    body["access_token"]
        .as_str()
        .or_else(|| body["token"].as_str())
        .expect("token in response")
        .to_string()
}

fn request(
    server: &TestServer,
    method: &str,
    path: &str,
) -> reqwest::RequestBuilder {
    let url = server.api_url(path);
    match method {
        "GET" => server.client.get(url),
        "PUT" => server.client.put(url).json(&json!({})),
        "POST" => server.client.post(url).json(&json!({})),
        m => panic!("unhandled method {m}"),
    }
}

#[tokio::test]
async fn deleted_predicate_routes_are_404_for_an_admin_holding_every_permission() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    // POSITIVE CONTROL FIRST. If the server mounted nothing at all, every assertion
    // below would pass for the wrong reason.
    let alive = server
        .client
        .get(server.api_url("/auth/me"))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("GET /auth/me");
    assert_eq!(
        alive.status().as_u16(),
        200,
        "the router is up and the admin token is valid — without this the 404s below prove nothing"
    );

    for (method, path) in DELETED {
        let resp = request(&server, method, path)
            .bearer_auth(&admin)
            .send()
            .await
            .unwrap_or_else(|e| panic!("{method} {path}: {e}"));
        let code = resp.status().as_u16();
        assert_eq!(
            code, 404,
            "{method} {path} answered {code}, not 404. The admin holds the `*` wildcard, so a \
             403 here would mean the route is still MOUNTED and the module still compiled in — \
             one grant away from live. ITEM-4 deletes the module, not its permissions."
        );
    }
}

#[tokio::test]
async fn deleted_predicate_routes_are_404_not_401_without_a_token() {
    let server = TestServer::spawn().await;

    // POSITIVE CONTROL: a SURVIVING gated route answers 401 unauthenticated. That is the
    // status a still-mounted predicate route would produce, so it is the exact value the
    // assertions below must NOT see.
    let gated = server
        .client
        .get(server.api_url("/auth/me"))
        .send()
        .await
        .expect("GET /auth/me unauthenticated");
    assert_eq!(
        gated.status().as_u16(),
        401,
        "a surviving gated route must answer 401 unauthenticated — the control for the 404s below"
    );

    for (method, path) in DELETED {
        let resp = request(&server, method, path)
            .send()
            .await
            .unwrap_or_else(|e| panic!("{method} {path}: {e}"));
        let code = resp.status().as_u16();
        assert_eq!(
            code, 404,
            "{method} {path} answered {code}. 401 would mean the route is mounted behind an auth \
             layer; only 404 proves the router never learned the path."
        );
    }
}

#[tokio::test]
async fn the_app_boots_with_the_predicate_limits_migration_removed() {
    // ITEM-4 deleted `202607250001_predicate_settings.sql` and added a DROP migration.
    // `set_ignore_missing(true)` means a REMOVED migration would not hard-fail an existing
    // DB — so the failure this guards against is silent: the table lingers as an orphan.
    // A fresh per-test DB is migrated from scratch, so its absence here is the real check.
    let server = TestServer::spawn().await;

    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(2)
        .connect(server.database_url())
        .await
        .expect("connect to the per-test DB");

    // POSITIVE CONTROL: the schema really was migrated.
    let projects: bool = sqlx::query_scalar("SELECT to_regclass('public.projects') IS NOT NULL")
        .fetch_one(&pool)
        .await
        .expect("probe projects");
    assert!(projects, "the per-test DB is migrated — without this the absences below are vacuous");

    for table in ["predicate_limits", "predicate_settings"] {
        let exists: bool =
            sqlx::query_scalar(&format!("SELECT to_regclass('public.{table}') IS NOT NULL"))
                .fetch_one(&pool)
                .await
                .unwrap_or_else(|e| panic!("probe {table}: {e}"));
        assert!(!exists, "`{table}` still exists after ITEM-4 — an orphaned table");
    }
}

#[tokio::test]
async fn the_versioned_predicate_recipe_envelope_is_refused_rather_than_reinterpreted() {
    // `POST /provenance/selections` SURVIVES ITEM-4 but its recipe payload used to accept
    // the versioned predicate-DSL envelope. Silently reinterpreting such a payload as a
    // flat recipe is precisely the double-encoding defect INV-10 forbids, so it must be
    // REFUSED — and this is the one place a caller could still smuggle a predicate in.
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    let project = server
        .client
        .post(server.api_url("/projects"))
        .bearer_auth(&admin)
        .json(&json!({ "name": "predicate refusal", "description": "" }))
        .send()
        .await
        .expect("create project");
    assert_eq!(project.status().as_u16(), 201);
    let project_id = project.json::<Value>().await.expect("project json")["id"]
        .as_str()
        .expect("project id")
        .to_string();

    let resp = server
        .client
        .post(server.api_url("/provenance/selections"))
        .bearer_auth(&admin)
        .json(&json!({
            "project_id": project_id,
            "input_artifact_id": uuid::Uuid::new_v4(),
            "recipe": { "predicate": { "idList": { "ids": [0, 1] } }, "dsl_version": "1" },
            "label": "smuggled",
        }))
        .send()
        .await
        .expect("post selection");
    let code = resp.status().as_u16();
    assert_eq!(
        code, 400,
        "the scrapped predicate envelope must be REFUSED with a 400, not silently \
         reinterpreted (got {code})"
    );
}
