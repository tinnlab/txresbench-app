//! P10 project-scope integration tests — the NET-NEW seams this lifecycle adds
//! (behavior-preservation of the `ProjectScope` refactor is covered by the existing
//! `shares.rs`/`transfer.rs`/`admin_test.rs`/`extensions.rs`, which re-run green).
//! Covers: `ProjectScope::resolve_admin` (admin override, no widening — TEST-5),
//! `GET /projects/{id}/access` (two-level precedence + per-role shape — TEST-7/16),
//! the `GcManifest` chokepoint plumbing + sweep (TEST-12), `project_audience`
//! (TEST-14/19), and transfer re-scoping (TEST-17).

use std::sync::Arc;

use serde_json::{json, Value};
use uuid::Uuid;

use super::{create_dataset, create_project, create_user, create_user_without_projects, login, setup_admin};
use crate::common::TestServer;

use txresbench::modules::dataset::project_extension::extension::DatasetProjectExtension;
use txresbench::modules::project::{
    project_audience, sweep_gc_manifest, GcManifest, ProjectExtensionRegistry, ProjectRepository,
    ProjectScope,
};

// --------------------------- local flow helpers ---------------------------

async fn share(server: &TestServer, owner: &str, sid: &str, email: &str, level: &str) -> String {
    let resp = server
        .client
        .post(server.api_url(&format!("/projects/{sid}/shares")))
        .bearer_auth(owner)
        .json(&json!({ "email": email, "permission_level": level }))
        .send()
        .await
        .expect("share");
    assert_eq!(resp.status().as_u16(), 201, "share {email} {level}");
    resp.json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string()
}

async fn accept_share(server: &TestServer, recipient: &str, share_id: &str) {
    let r = server
        .client
        .post(server.api_url(&format!("/project-shares/{share_id}/accept")))
        .bearer_auth(recipient)
        .send()
        .await
        .expect("accept share");
    assert_eq!(r.status().as_u16(), 200, "accept share");
}

async fn attach_dataset(server: &TestServer, token: &str, sid: &str, dataset_id: &str) {
    let r = server
        .client
        .post(server.api_url(&format!("/projects/{sid}/datasets/{dataset_id}")))
        .bearer_auth(token)
        .send()
        .await
        .expect("attach");
    assert_eq!(r.status().as_u16(), 200, "attach dataset");
}

fn uid(v: &Value) -> Uuid {
    Uuid::parse_str(v.as_str().expect("string id")).expect("uuid")
}

// ------------------------------- TEST-5 -------------------------------

/// `resolve_admin` reaches any project for a project-admin, but never widens a
/// non-admin; the base `resolve` never elevates. Exercised against the real DB.
#[tokio::test]
async fn resolve_admin_reaches_but_never_widens() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    // The root admin's user id = owner_id of a project it creates.
    let admin_owned = create_project(&server, &admin, "admin-owned").await;
    let admin_id = uid(&admin_owned["owner_id"]);

    let x_id = create_user(&server, &admin, "xowner", "x@x.test").await;
    let x = login(&server, "xowner").await;
    let y_id = create_user(&server, &admin, "youtsider", "y@x.test").await;

    let project = create_project(&server, &x, "X private project").await;
    let sid = uid(&project["id"]);
    let x_uuid = Uuid::parse_str(&x_id).unwrap();
    let y_uuid = Uuid::parse_str(&y_id).unwrap();

    let pool = sqlx::SqlitePool::connect(server.database_url()).await.unwrap();
    let repo = ProjectRepository::new(pool);

    // Base guard: the admin has no ACL on X's project → None (no widening baked in).
    assert!(
        ProjectScope::resolve(&repo, sid, admin_id).await.unwrap().is_none(),
        "base resolve never elevates an admin"
    );

    // Admin override: a project-admin reaches X's project as Owner (override flag set).
    let admin_scope = ProjectScope::resolve_admin(&repo, sid, admin_id, true)
        .await
        .unwrap()
        .expect("admin reaches foreign project");
    assert!(admin_scope.is_owner());
    assert!(admin_scope.admin_override, "reached via override, not a real ACL");

    // The real owner resolves via override path too, but as a REAL ACL (no flag).
    let owner_scope = ProjectScope::resolve_admin(&repo, sid, x_uuid, false)
        .await
        .unwrap()
        .expect("owner resolves");
    assert!(owner_scope.is_owner());
    assert!(!owner_scope.admin_override, "the real owner is not an override");

    // A non-admin outsider is NOT widened (R8).
    assert!(
        ProjectScope::resolve_admin(&repo, sid, y_uuid, false).await.unwrap().is_none(),
        "a non-admin with no ACL is never widened"
    );
}

// ------------------------------- TEST-7 -------------------------------

/// `GET /projects/{id}/access` enforces the two-level precedence: the OUTER
/// `projects::use` capability (403) BEFORE the INNER project role (404).
#[tokio::test]
async fn access_two_level_precedence() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "owner7", "o7@x.test").await;
    let owner = login(&server, "owner7").await;
    let project = create_project(&server, &owner, "Access project").await;
    let sid = project["id"].as_str().unwrap();

    // Unauthenticated → 401.
    let un = server.client.get(server.api_url(&format!("/projects/{sid}/access"))).send().await.unwrap();
    assert_eq!(un.status().as_u16(), 401);

    // A user WITHOUT projects::use → 403 (outer capability fires first), even
    // though the inner project check would be a 404.
    create_user_without_projects(&server, &admin, "nocap7", "nc7@x.test").await;
    let nocap = login(&server, "nocap7").await;
    let cap403 = server.client.get(server.api_url(&format!("/projects/{sid}/access"))).bearer_auth(&nocap).send().await.unwrap();
    assert_eq!(cap403.status().as_u16(), 403, "no projects::use → 403 (outer) before project 404");

    // A projects::use holder who can't see the project → 404 (inner role).
    create_user(&server, &admin, "stranger7", "s7@x.test").await;
    let stranger = login(&server, "stranger7").await;
    let inner404 = server.client.get(server.api_url(&format!("/projects/{sid}/access"))).bearer_auth(&stranger).send().await.unwrap();
    assert_eq!(inner404.status().as_u16(), 404, "visible-to-nobody project → 404 (inner)");
}

// ------------------------------- TEST-16 -------------------------------

/// `GET /projects/{id}/access` returns the correct `{role, can_edit, is_owner}` per
/// role (owner/editor/viewer).
#[tokio::test]
async fn access_shape_per_role() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "owner16", "o16@x.test").await;
    let owner = login(&server, "owner16").await;
    create_user(&server, &admin, "editor16", "e16@x.test").await;
    let editor = login(&server, "editor16").await;
    create_user(&server, &admin, "viewer16", "v16@x.test").await;
    let viewer = login(&server, "viewer16").await;

    let project = create_project(&server, &owner, "Roles project").await;
    let sid = project["id"].as_str().unwrap().to_string();

    let es = share(&server, &owner, &sid, "e16@x.test", "editor").await;
    accept_share(&server, &editor, &es).await;
    let vs = share(&server, &owner, &sid, "v16@x.test", "viewer").await;
    accept_share(&server, &viewer, &vs).await;

    async fn access(server: &TestServer, token: &str, sid: &str) -> Value {
        server.client.get(server.api_url(&format!("/projects/{sid}/access"))).bearer_auth(token).send().await.unwrap().json().await.unwrap()
    }

    let o = access(&server, &owner, &sid).await;
    assert_eq!(o["role"], json!("owner"));
    assert_eq!(o["can_edit"], json!(true));
    assert_eq!(o["is_owner"], json!(true));
    assert_eq!(o["project_id"], json!(sid));

    let e = access(&server, &editor, &sid).await;
    assert_eq!(e["role"], json!("editor"));
    assert_eq!(e["can_edit"], json!(true));
    assert_eq!(e["is_owner"], json!(false));

    let v = access(&server, &viewer, &sid).await;
    assert_eq!(v["role"], json!("viewer"));
    assert_eq!(v["can_edit"], json!(false));
    assert_eq!(v["is_owner"], json!(false));

    // Foreign project → 404.
    create_user(&server, &admin, "outsider16", "out16@x.test").await;
    let outsider = login(&server, "outsider16").await;
    let foreign = server.client.get(server.api_url(&format!("/projects/{sid}/access"))).bearer_auth(&outsider).send().await.unwrap();
    assert_eq!(foreign.status().as_u16(), 404);
}

// ------------------------------- TEST-12 -------------------------------

/// `fire_on_project_deleted` threads a `&mut GcManifest` to each registered
/// extension over a real tx (proven by firing the REAL dataset extension: it runs
/// its cleanup and receives the collector), and the P1 sweep stub is Ok on empty
/// + populated. Uses a LOCAL registry (the global one is set only in the server
/// subprocess), so this exercises the fire-loop threading directly.
///
/// The sweep half reads the PROCESS-WIDE store + ownership claim, which is why the
/// harness — not this test, and not whichever peer happened to run first — installs
/// them. Without that, this test passed alone and failed under parallelism: peers
/// installed a private root into the `OnceCell`s and then deleted it, so the sweep
/// aimed at a directory that no longer existed and `partition::verify_covers`
/// correctly refused ("its `.catalog-owner` claim could not be read"). Asking for
/// the shared root makes the precondition this test depends on an explicit one.
/// See `common::object_store`.
#[tokio::test]
async fn gc_manifest_threading_and_sweep() {
    crate::common::object_store::shared_object_store_root();
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "gcowner", "gc@x.test").await;
    let owner = login(&server, "gcowner").await;
    let project = create_project(&server, &owner, "GC project").await;
    let sid = uid(&project["id"]);
    let ds = create_dataset(&server, &owner, "gc-matrix").await;
    attach_dataset(&server, &owner, &sid.to_string(), &ds).await;

    let pool = sqlx::SqlitePool::connect(server.database_url()).await.unwrap();

    // Build a registry with the REAL dataset extension + fire it over a real tx,
    // threading a project-scoped manifest through it.
    let mut registry = ProjectExtensionRegistry::new();
    registry.register(Arc::new(DatasetProjectExtension::new(pool.clone())));
    let mut gc = GcManifest::for_project(sid);
    let mut tx = pool.begin().await.unwrap();
    registry.fire_on_project_deleted(sid, &mut tx, &mut gc).await.expect("fire");
    tx.commit().await.unwrap();

    // The ext RAN over the threaded tx and received the collector. Post ITEM-1/3
    // (M:N, owner-scoped datasets) its `on_project_deleted` is a no-op for the
    // datasets themselves — they SURVIVE a project delete (the project_datasets
    // junction cascades, but the owner keeps the dataset). So the dataset row is
    // still present here (the real cascade only fires on an actual project-row DELETE).
    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM datasets WHERE id = $1")
        .bind(uuid::Uuid::parse_str(&ds).expect("dataset id is a uuid"))
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(remaining, 1, "on_project_deleted keeps the owner's dataset (M:N, no destroy)");
    // …and it received the `&mut GcManifest` collector (empty — the blob-GC
    // retrofit is descoped this round; ITEM-10). The threading is a compile-time
    // hook param + this proves the fire-loop passes it to a real ext.
    assert!(gc.is_empty(), "no extension marks blobs yet (ITEM-10 descoped)");
    assert_eq!(gc.project_id, Some(sid));

    // The P1-owned sweep stub is Ok on an empty AND a populated manifest (live pool).
    sweep_gc_manifest(&pool, &gc).await.expect("sweep empty ok");
    let mut populated = GcManifest::for_project(sid);
    populated.mark("deadbeefcafe", "test");
    assert_eq!(populated.len(), 1);
    sweep_gc_manifest(&pool, &populated).await.expect("sweep populated ok");
}

// ------------------------------- TEST-14 / TEST-19 -------------------------------

/// `project_audience` = owner ∪ ACCEPTED recipients (a pending share is excluded).
#[tokio::test]
async fn project_audience_is_owner_union_accepted() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let owner_id = create_user(&server, &admin, "aud_owner", "ao@x.test").await;
    let owner = login(&server, "aud_owner").await;
    let ed_id = create_user(&server, &admin, "aud_ed", "ae@x.test").await;
    let ed = login(&server, "aud_ed").await;
    let vw_id = create_user(&server, &admin, "aud_vw", "av@x.test").await;
    let vw = login(&server, "aud_vw").await;
    // A pending (never accepted) recipient must be EXCLUDED.
    let _pending_id = create_user(&server, &admin, "aud_pending", "ap@x.test").await;

    let project = create_project(&server, &owner, "Audience project").await;
    let sid = uid(&project["id"]);

    let es = share(&server, &owner, &sid.to_string(), "ae@x.test", "editor").await;
    accept_share(&server, &ed, &es).await;
    let vs = share(&server, &owner, &sid.to_string(), "av@x.test", "viewer").await;
    accept_share(&server, &vw, &vs).await;
    // Share with the pending user but do NOT accept.
    let _ps = share(&server, &owner, &sid.to_string(), "ap@x.test", "viewer").await;

    let pool = sqlx::SqlitePool::connect(server.database_url()).await.unwrap();
    let repo = ProjectRepository::new(pool);

    // #168: the audience is now `Option` — `None` means nobody may see the project,
    // a state that previously could not be expressed and was expressed instead as
    // "address the ex-owner".
    let (got_owner, recipients) = project_audience(&repo, sid)
        .await
        .unwrap()
        .expect("a live project with a current owner has a non-empty audience");
    assert_eq!(got_owner, Uuid::parse_str(&owner_id).unwrap(), "audience owner");
    let ed_u = Uuid::parse_str(&ed_id).unwrap();
    let vw_u = Uuid::parse_str(&vw_id).unwrap();
    assert!(recipients.contains(&ed_u), "accepted editor in audience");
    assert!(recipients.contains(&vw_u), "accepted viewer in audience");
    assert_eq!(recipients.len(), 2, "exactly the 2 ACCEPTED shares (pending excluded)");
}

/// Empty-audience degeneracy (desktop single-user): a project with NO accepted
/// shares yields an empty recipient list — no panic, a valid fan-to-self.
#[tokio::test]
async fn project_audience_empty_is_fan_to_self() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let owner_id = create_user(&server, &admin, "solo", "solo@x.test").await;
    let owner = login(&server, "solo").await;
    let project = create_project(&server, &owner, "Solo project").await;
    let sid = uid(&project["id"]);

    let pool = sqlx::SqlitePool::connect(server.database_url()).await.unwrap();
    let repo = ProjectRepository::new(pool);

    let (got_owner, recipients) = project_audience(&repo, sid)
        .await
        .unwrap()
        .expect("a solo owner is their personal account's only member, so the \
                 audience is exactly them (#168 INV-5)");
    assert_eq!(got_owner, Uuid::parse_str(&owner_id).unwrap());
    assert!(recipients.is_empty(), "no accepted shares → empty recipients (no panic)");
}

// ------------------------------- TEST-17 -------------------------------

/// Transfer accept re-scopes access purely via `effective_permission`: the new
/// owner is `owner`, the OLD owner loses access (404 — no owner-scoped orphan),
/// and the data (datasets) is intact (project-scoped, no owner cascade).
#[tokio::test]
async fn transfer_rescopes_without_data_cascade() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let _old_id = create_user(&server, &admin, "t_old", "told@x.test").await;
    let old = login(&server, "t_old").await;
    let new_id = create_user(&server, &admin, "t_new", "tnew@x.test").await;
    let new = login(&server, "t_new").await;

    let project = create_project(&server, &old, "Transfer project").await;
    let sid = project["id"].as_str().unwrap().to_string();
    let ds = create_dataset(&server, &old, "matrix-1").await;
    attach_dataset(&server, &old, &sid, &ds).await;

    // Old owner offers transfer; new accepts.
    let tid = server.client.post(server.api_url(&format!("/projects/{sid}/transfer")))
        .bearer_auth(&old).json(&json!({ "email": "tnew@x.test" })).send().await.unwrap()
        .json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string();
    let acc = server.client.post(server.api_url(&format!("/project-transfers/{tid}/accept"))).bearer_auth(&new).send().await.unwrap();
    assert_eq!(acc.status().as_u16(), 200);

    // New owner: project is now theirs, role `owner`.
    let ng: Value = server.client.get(server.api_url(&format!("/projects/{sid}"))).bearer_auth(&new).send().await.unwrap().json().await.unwrap();
    assert_eq!(ng["owner_id"], json!(new_id));
    assert_eq!(ng["effective_permission"], json!("owner"));

    // Old owner LOST access (no residual share) → 404, not an orphaned owner-scope.
    let og = server.client.get(server.api_url(&format!("/projects/{sid}"))).bearer_auth(&old).send().await.unwrap();
    assert_eq!(og.status().as_u16(), 404, "old owner has no access after transfer");

    // The dataset is INTACT under the new owner (project-scoped, no owner cascade).
    let ds_list: Value = server.client.get(server.api_url(&format!("/projects/{sid}/datasets"))).bearer_auth(&new).send().await.unwrap().json().await.unwrap();
    assert_eq!(ds_list["total"], json!(1), "dataset survived the ownership transfer");
}
