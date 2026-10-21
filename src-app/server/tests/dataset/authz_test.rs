//! Dataset authorization — the two boundaries the blind audit found untested:
//!
//! 1. **Capability gate** (`projects::use`): a user WITHOUT the permission gets
//!    **403** (not 401, not 200) on the dataset endpoints. The audit noted only
//!    2/15 endpoints asserted even 401 and NONE asserted 403 for a
//!    permitted-but-unauthorized user — so dropping the perm gate would pass every
//!    prior test. This is that regression guard.
//! 2. **Share-role enforcement** (`view` vs `edit`): a read-only `view` sharee is
//!    REFUSED (403) on a MUTATION (rename) and on `POST /datasets/{id}/process`,
//!    while an `edit`-role sharee is ALLOWED — the ITEM-2 role that was stored +
//!    validated but never enforced.

use reqwest::multipart::{Form, Part};
use serde_json::{json, Value};
use uuid::Uuid;

use super::{create_user, login, setup_admin};
use crate::common::TestServer;

/// The seeded Users group id (holds `projects::use`). Stripping a user from it
/// leaves them with no capability to reach the dataset surface. Mirrors the
/// `project` tests' `create_user_without_projects` helper.
const USERS_GROUP_ID: &str = "79668b78-16ff-4d3f-80e6-afdbb3236dc9";

/// Create a user then REMOVE them from the Users group → they no longer hold
/// `projects::use` (the capability gate on every dataset endpoint).
async fn create_user_without_projects(
    server: &TestServer,
    admin: &str,
    username: &str,
    email: &str,
) -> String {
    let id = create_user(server, admin, username, email).await;
    let resp = server
        .client
        .delete(server.api_url(&format!("/groups/{id}/{USERS_GROUP_ID}/remove")))
        .bearer_auth(admin)
        .send()
        .await
        .expect("remove from Users group");
    assert!(
        resp.status().is_success(),
        "strip Users group: {}",
        resp.status()
    );
    id
}

/// Upload one CSV file → one dataset (owned by `token`'s user); returns its id.
/// Gives the dataset a file so `POST /process` can enqueue (needs ≥1 file).
async fn upload_one(server: &TestServer, token: &str, filename: &str) -> String {
    let form = Form::new().part(
        "file",
        Part::bytes(b"cell,gene_a\ncell_1,3\n".to_vec()).file_name(filename.to_string()),
    );
    let resp = server
        .client
        .post(server.api_url("/datasets/upload"))
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await
        .expect("upload");
    assert_eq!(resp.status().as_u16(), 200, "upload succeeds");
    let body: Value = resp.json().await.expect("upload json");
    body["datasets"][0]["id"]
        .as_str()
        .expect("dataset id")
        .to_string()
}

/// Share `ds` (owned by `owner`) with `principal_id` at `role` (user principal).
async fn share_with(server: &TestServer, owner: &str, ds: &str, principal_id: &str, role: &str) {
    let resp = server
        .client
        .post(server.api_url(&format!("/datasets/{ds}/shares")))
        .bearer_auth(owner)
        .json(&json!({ "principal_type": "user", "principal_id": principal_id, "role": role }))
        .send()
        .await
        .expect("share");
    assert_eq!(resp.status().as_u16(), 201, "share ({role}) created");
}

/// A user WITHOUT `projects::use` is refused (403) across the dataset surface —
/// reads, writes, folders, AND process — while an unauthenticated request is 401.
/// (Capability 403 fires structurally BEFORE the in-body scope check, so even a
/// ghost-dataset `process` is a 403 for the permissionless user.)
#[tokio::test]
async fn dataset_surface_403_without_projects_use() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user_without_projects(&server, &admin, "nobody", "nobody@x.test").await;
    let nobody = login(&server, "nobody").await;

    let ghost = Uuid::new_v4();
    // (method, url, optional-json-body) tuples across the surface.
    let get_paths = ["/datasets", "/datasets/shared", "/dataset-folders"];
    for p in get_paths {
        let r = server
            .client
            .get(server.api_url(p))
            .bearer_auth(&nobody)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status().as_u16(), 403, "GET {p} gated on projects::use");
        // Unauthenticated → 401 (near-zero 401 coverage before).
        let anon = server.client.get(server.api_url(p)).send().await.unwrap();
        assert_eq!(anon.status().as_u16(), 401, "GET {p} unauthenticated → 401");
    }

    let create = server
        .client
        .post(server.api_url("/datasets"))
        .bearer_auth(&nobody)
        .json(&json!({ "name": "x" }))
        .send()
        .await
        .unwrap();
    assert_eq!(create.status().as_u16(), 403, "POST /datasets gated");

    let folder = server
        .client
        .post(server.api_url("/dataset-folders"))
        .bearer_auth(&nobody)
        .json(&json!({ "name": "f" }))
        .send()
        .await
        .unwrap();
    assert_eq!(folder.status().as_u16(), 403, "POST /dataset-folders gated");

    let process = server
        .client
        .post(server.api_url(&format!("/datasets/{ghost}/process")))
        .bearer_auth(&nobody)
        .json(&json!({ "spec": { "language": "python", "script": "print(1)" } }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        process.status().as_u16(),
        403,
        "POST /process gated (capability before scope)"
    );
}

/// A `view`-role sharee may READ but is REFUSED (403) on a mutation (rename) and
/// on `POST /process`; an `edit`-role sharee is ALLOWED on both; a foreign
/// non-sharee gets 404 (no existence oracle), never 403.
#[tokio::test]
async fn view_sharee_refused_edit_sharee_allowed() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "owner", "owner@x.test").await;
    let owner = login(&server, "owner").await;
    let viv_id = create_user(&server, &admin, "viv", "viv@x.test").await;
    let viv = login(&server, "viv").await;
    let eddie_id = create_user(&server, &admin, "eddie", "eddie@x.test").await;
    let eddie = login(&server, "eddie").await;
    create_user(&server, &admin, "stranger", "stranger@x.test").await;
    let stranger = login(&server, "stranger").await;

    // Owner uploads a one-file dataset, shares view→viv, edit→eddie.
    let ds = upload_one(&server, &owner, "PBMC.csv").await;
    share_with(&server, &owner, &ds, &viv_id, "view").await;
    share_with(&server, &owner, &ds, &eddie_id, "edit").await;

    let process_body = json!({ "spec": { "language": "python", "script": "print('qc')" } });

    // --- view sharee: reads OK, mutations 403. ---
    let viv_get = server
        .client
        .get(server.api_url(&format!("/datasets/{ds}")))
        .bearer_auth(&viv)
        .send()
        .await
        .unwrap();
    assert_eq!(
        viv_get.status().as_u16(),
        200,
        "view sharee can READ the dataset"
    );

    let viv_rename = server
        .client
        .put(server.api_url(&format!("/datasets/{ds}")))
        .bearer_auth(&viv)
        .json(&json!({"name":"hax"}))
        .send()
        .await
        .unwrap();
    assert_eq!(
        viv_rename.status().as_u16(),
        403,
        "view sharee CANNOT rename (403)"
    );

    let viv_process = server
        .client
        .post(server.api_url(&format!("/datasets/{ds}/process")))
        .bearer_auth(&viv)
        .json(&process_body)
        .send()
        .await
        .unwrap();
    assert_eq!(
        viv_process.status().as_u16(),
        403,
        "view sharee CANNOT process (403)"
    );

    // --- edit sharee: mutations allowed. ---
    let eddie_rename = server
        .client
        .put(server.api_url(&format!("/datasets/{ds}")))
        .bearer_auth(&eddie)
        .json(&json!({"name":"eddie-edit"}))
        .send()
        .await
        .unwrap();
    assert_eq!(
        eddie_rename.status().as_u16(),
        200,
        "edit sharee CAN rename"
    );
    assert_eq!(
        eddie_rename.json::<Value>().await.unwrap()["name"],
        json!("eddie-edit")
    );

    let eddie_process = server
        .client
        .post(server.api_url(&format!("/datasets/{ds}/process")))
        .bearer_auth(&eddie)
        .json(&process_body)
        .send()
        .await
        .unwrap();
    assert_eq!(
        eddie_process.status().as_u16(),
        201,
        "edit sharee CAN process (job enqueued)"
    );

    // --- foreign non-sharee: 404 (no oracle), NOT 403. ---
    let stranger_rename = server
        .client
        .put(server.api_url(&format!("/datasets/{ds}")))
        .bearer_auth(&stranger)
        .json(&json!({"name":"nope"}))
        .send()
        .await
        .unwrap();
    assert_eq!(
        stranger_rename.status().as_u16(),
        404,
        "non-sharee rename → 404 (no oracle)"
    );

    let stranger_process = server
        .client
        .post(server.api_url(&format!("/datasets/{ds}/process")))
        .bearer_auth(&stranger)
        .json(&process_body)
        .send()
        .await
        .unwrap();
    assert_eq!(
        stranger_process.status().as_u16(),
        404,
        "non-sharee process → 404 (no oracle)"
    );
}

/// **One capability must not have two security models.**
///
/// Enqueuing a dataset-scoped analysis job is reachable two ways — `POST /jobs` with a
/// `dataset_id`, and `POST /datasets/{id}/process` — and they answered "who may run a
/// job on this dataset" differently: `/process` admitted an `edit`-role sharee
/// (`require_can_edit`), `/jobs` demanded OWNERSHIP. A user's authority depended on
/// which route they reached for.
///
/// This asserts the invariant rather than either endpoint's grade: for every
/// principal, **both routes return the same status**. It is table-driven over the
/// full four-principal matrix because a single-user test cannot see this class at all
/// — owner-only and edit-sharee-allowed are indistinguishable when the only actor IS
/// the owner, which is why the disagreement survived.
///
/// NEGATIVE CONTROLS, both required for the parity claim to mean anything:
///   * the `view` sharee (403) and the stranger (404) prove parity is not being
///     satisfied by "both routes accept everyone" — the gate still grades, and it
///     still grades 403 vs 404 distinctly (no existence oracle);
///   * the stranger's 404 on a dataset the owner's 201 proves EXISTS rules out
///     "both routes 404 because nothing is reachable".
#[tokio::test]
async fn jobs_and_process_agree_on_who_may_run_a_dataset_job() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "dj_owner", "dj_owner@x.test").await;
    let owner = login(&server, "dj_owner").await;
    let viv_id = create_user(&server, &admin, "dj_viv", "dj_viv@x.test").await;
    let viv = login(&server, "dj_viv").await;
    let eddie_id = create_user(&server, &admin, "dj_eddie", "dj_eddie@x.test").await;
    let eddie = login(&server, "dj_eddie").await;
    create_user(&server, &admin, "dj_stranger", "dj_stranger@x.test").await;
    let stranger = login(&server, "dj_stranger").await;

    let ds = upload_one(&server, &owner, "table.csv").await;
    share_with(&server, &owner, &ds, &viv_id, "view").await;
    share_with(&server, &owner, &ds, &eddie_id, "edit").await;

    let spec = json!({ "language": "python", "script": "print('qc')" });

    for (who, token, expected) in [
        ("owner", &owner, 201u16),
        ("edit sharee", &eddie, 201),
        ("view sharee", &viv, 403),
        ("stranger", &stranger, 404),
    ] {
        // Route A — the dedicated processing endpoint.
        let via_process = server
            .client
            .post(server.api_url(&format!("/datasets/{ds}/process")))
            .bearer_auth(token)
            .json(&json!({ "spec": spec }))
            .send()
            .await
            .unwrap();
        let a = via_process.status().as_u16();

        // Route B — the generic jobs endpoint carrying the same dataset scope.
        let via_jobs = server
            .client
            .post(server.api_url("/jobs"))
            .bearer_auth(token)
            .json(&json!({
                "job_type": "analysis",
                "name": format!("{who}-via-jobs"),
                "dataset_id": ds,
                "params": spec,
            }))
            .send()
            .await
            .unwrap();
        let b = via_jobs.status().as_u16();

        assert_eq!(
            a, expected,
            "{who}: POST /datasets/{{id}}/process expected {expected}, got {a}"
        );
        assert_eq!(
            b, expected,
            "{who}: POST /jobs with dataset_id expected {expected}, got {b}"
        );
        assert_eq!(
            a, b,
            "{who}: the two routes to the SAME capability disagree \
             (/process={a}, /jobs={b}) — a user's authority must not depend on \
             which endpoint they reach for"
        );
    }
}
