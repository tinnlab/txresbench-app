//! **The authorization test for the artifact BYTE PLANE.**
//!
//! `workstore::authz::require_artifact_read` is the sole gate on the three
//! by-artifact-id read surfaces:
//!
//!   * `GET /artifacts/{id}` — the typed metadata,
//!   * `GET /artifacts/{id}/data` — the whole object's bytes,
//!   * `GET /artifacts/{id}/data/{*member}` — one member of a multi-file object.
//!
//! Since artifact-model ITEM-12 deleted `GET /artifacts/{id}/read`, that byte plane
//! is the **only** read surface the workstore has, so every byte a user can reach
//! flows through this one function. It dispatches on the artifact's own tenancy
//! scope (`authz.rs::artifact_scope`) into TWO arms, and both are live in
//! production: a **project**-scoped artifact resolves through the project role
//! (`require_project_read`, Viewer+), a **dataset**-scoped one through dataset
//! visibility (`require_dataset_read` = owner ∪ user-shares ∪ group-shares).
//!
//! ## Why this file exists
//!
//! It did not, and the gate was therefore untested. Replacing the whole body of
//! `require_artifact_read` with `Ok(())` — a total cross-user, cross-project,
//! cross-dataset read bypass — left **216 tests across seven modules green**. The
//! two suites that looked like coverage are not: `test16_foreign_project_is_404`
//! exercises the project-scoped JSON *control* plane (`/projects/{id}/artifacts`),
//! which is gated by `require_project_read` directly and never touches this
//! function; `test234_artifact_delete_requires_edit_not_read` exercises DELETE,
//! which was deliberately moved OFF this gate onto `require_project_edit`. The
//! dataset arm had no integration coverage at all.
//!
//! ## What makes this a test of the GATE and not of the routes
//!
//! Every refusal below is paired with a **positive control on the same artifact and
//! the same URL**: a principal who legitimately holds access gets `200` and the
//! exact bytes. Without that, a 404 could equally mean "the fixture never seeded",
//! "the route is not mounted", or "the id is wrong" — and the assertions would hold
//! with the gate removed *and* with the whole byte plane removed.
//!
//! The refusal status is asserted as **404, never 403**: the scope is invisible
//! rather than forbidden, so the response may not confirm that the artifact exists.
//! A test that accepted "not 200" would pass on a 403 and quietly license the leak.
//!
//! The dataset arm is exercised through **three different answers**, because
//! `require_dataset_read` resolves three distinct principals in one SQL predicate
//! and a partial implementation satisfies any one of them: a non-shared user (404),
//! a USER-shared user (200), and a GROUP-shared user (200) — plus a member of no
//! group as the group arm's own negative control.

use serde_json::{json, Value};
use uuid::Uuid;

use txresbench::modules::workstore::catalog::repository::CatalogRepository;
use txresbench::modules::workstore::object_store::ObjectStore;

use super::{
    create_member_token, create_project, new_artifact, new_dataset_artifact, pool_for,
    server_store, setup_admin,
};
use crate::common::TestServer;

/// The bytes of the single-file fixture, and of the multi-file fixture's member.
/// Distinct, so a member read that silently served the whole object (or the wrong
/// member) is visible in the assertion rather than passing on equal bytes.
const SINGLE_BYTES: &[u8] = b"single-file artifact payload";
const MEMBER_BYTES: &[u8] = b"one member inside a multi-file artifact";
/// The member PATH used on `/data/{*member}` — a nested path, so the wildcard
/// segment is genuinely exercised.
const MEMBER_PATH: &str = "nested/member.bin";

/// The two artifacts one tenancy scope is seeded with: a single-file object (which
/// `/data` serves whole; a multi-file object answers `MEMBER_REQUIRED` there) and a
/// multi-file object (which `/data/{*member}` serves by path).
struct Fixture {
    single: Uuid,
    multi: Uuid,
}

/// Assert all FOUR gated requests answer `expect` for this bearer token — and, when
/// `expect` is 200, that each carries exactly the bytes seeded.
///
/// `GET /artifacts/{id}` is checked against BOTH artifacts: the metadata surface is
/// gated by the same call and has no single/multi distinction, so checking one would
/// leave the other's row reachable by a gate that dispatched per artifact.
///
/// **Every surface is probed before anything is asserted**, and the whole
/// `(surface, status)` vector is compared at once. A per-request `assert_eq!` would
/// short-circuit on the first surface, so a gate removal would be reported as "the
/// metadata route leaked" and the two BYTE routes — the ones that actually carry
/// user data, and the only read surface left since ITEM-12 — would never be reached
/// on the failing run. This way one failure names every surface that leaked.
async fn assert_surfaces(
    server: &TestServer,
    token: Option<&str>,
    fx: &Fixture,
    expect: u16,
    who: &str,
) {
    let get = |url: String| {
        let req = server.client.get(url);
        let req = match token {
            Some(t) => req.bearer_auth(t),
            None => req,
        };
        req.send()
    };

    // (surface label, status, body) for every gated request, probed first.
    let mut probed: Vec<(String, u16, Vec<u8>)> = Vec::new();
    for (label, id) in [("single", fx.single), ("multi", fx.multi)] {
        let r = get(server.api_url(&format!("/artifacts/{id}")))
            .await
            .expect("GET /artifacts/{id}");
        let status = r.status().as_u16();
        probed.push((
            format!("GET /artifacts/{{id}} ({label})"),
            status,
            r.bytes().await.expect("body").to_vec(),
        ));
    }
    let r = get(server.api_url(&format!("/artifacts/{}/data", fx.single)))
        .await
        .expect("GET /data");
    let status = r.status().as_u16();
    probed.push((
        "GET /artifacts/{id}/data".to_string(),
        status,
        r.bytes().await.expect("body").to_vec(),
    ));
    let r = get(server.api_url(&format!("/artifacts/{}/data/{MEMBER_PATH}", fx.multi)))
        .await
        .expect("GET /data/{member}");
    let status = r.status().as_u16();
    probed.push((
        "GET /artifacts/{id}/data/{*member}".to_string(),
        status,
        r.bytes().await.expect("body").to_vec(),
    ));

    let observed: Vec<(String, u16)> = probed.iter().map(|(l, s, _)| (l.clone(), *s)).collect();
    let wanted: Vec<(String, u16)> = probed.iter().map(|(l, _, _)| (l.clone(), expect)).collect();
    assert_eq!(
        observed, wanted,
        "{who}: every by-artifact-id read surface is gated by the SAME \
         `require_artifact_read` call, so they must answer alike. A 404 here means \
         invisible, never forbidden — a 403 would confirm the artifact exists."
    );

    if expect == 200 {
        // The metadata rows served are the ones requested …
        for ((label, _, body), id) in probed.iter().zip([fx.single, fx.multi]) {
            let row: Value = serde_json::from_slice(body).expect("artifact json");
            assert_eq!(
                row["id"].as_str(),
                Some(id.to_string().as_str()),
                "{who}: {label} served a different row than the one requested"
            );
        }
        // … and each byte route served the bytes that were seeded. Without this a
        // 200 carrying nothing would satisfy the status assertion and make every
        // 404 elsewhere in this file unfalsifiable.
        assert_eq!(
            probed[2].2.as_slice(),
            SINGLE_BYTES,
            "{who}: the whole-object read must serve the seeded bytes"
        );
        assert_eq!(
            probed[3].2.as_slice(),
            MEMBER_BYTES,
            "{who}: the member read must serve THAT member's bytes"
        );
    }
}

/// Seed the two fixture artifacts into a PROJECT scope (`project_id` set,
/// `dataset_id` NULL) with real blobs in the server's own object store.
async fn seed_project_fixture(server: &TestServer, project_id: Uuid) -> Fixture {
    let store = server_store(server);
    let single_key = store.put(SINGLE_BYTES).await.expect("put single blob");
    let multi = store
        .put_prefix(&[(MEMBER_PATH.to_string(), MEMBER_BYTES.to_vec())])
        .await
        .expect("put multi blob");
    let repo = CatalogRepository::new(pool_for(server).await);

    let single = repo
        .insert_artifact(&new_artifact(
            project_id,
            "single",
            single_key.as_str(),
            false,
        ))
        .await
        .expect("seed single");
    let multi = repo
        .insert_artifact(&new_artifact(
            project_id,
            "multi",
            multi.object_key.as_str(),
            true,
        ))
        .await
        .expect("seed multi");
    Fixture {
        single: single.id,
        multi: multi.id,
    }
}

/// Seed the two fixture artifacts into a DATASET scope (`dataset_id` set,
/// `project_id` NULL) — the shape an owner-processing / import run produces, and the
/// arm `require_dataset_read` governs.
async fn seed_dataset_fixture(server: &TestServer, dataset_id: Uuid) -> Fixture {
    let store = server_store(server);
    let single_key = store.put(SINGLE_BYTES).await.expect("put single blob");
    let multi_put = store
        .put_prefix(&[(MEMBER_PATH.to_string(), MEMBER_BYTES.to_vec())])
        .await
        .expect("put multi blob");
    let repo = CatalogRepository::new(pool_for(server).await);

    let single = repo
        .insert_artifact(&new_dataset_artifact(
            dataset_id,
            "single",
            single_key.as_str(),
        ))
        .await
        .expect("seed single");
    let mut multi_new = new_dataset_artifact(dataset_id, "multi", multi_put.object_key.as_str());
    multi_new.is_multifile = true;
    let multi = repo.insert_artifact(&multi_new).await.expect("seed multi");
    assert!(
        single.project_id.is_none() && single.dataset_id.is_some(),
        "the fixture is dataset-scoped, or this exercises the project arm by accident"
    );
    Fixture {
        single: single.id,
        multi: multi.id,
    }
}

// ───────────────────────── the PROJECT arm ─────────────────────────

/// A project-scoped artifact is readable by anyone holding a project ROLE and by
/// nobody else — on all three byte-plane surfaces.
#[tokio::test]
async fn project_scoped_artifact_bytes_are_gated_by_project_role() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let sid = create_project(&server, &admin, "byte authz").await;
    let fx = seed_project_fixture(&server, sid).await;

    // POSITIVE CONTROL — the project OWNER reads all three surfaces and gets the
    // seeded bytes. Every 404 below is therefore a refusal, not a broken fixture.
    assert_surfaces(&server, Some(&admin), &fx, 200, "project owner").await;

    // A user with `projects::use` but NO role on this project. They clear the route
    // permission gate, so the ONLY thing standing between them and another user's
    // bytes is `require_artifact_read`.
    let (_outsider_id, outsider) = create_member_token(&server, &admin, "byteoutsider").await;
    assert_surfaces(
        &server,
        Some(&outsider),
        &fx,
        404,
        "foreign-project outsider",
    )
    .await;

    // A VIEWER-shared collaborator DOES reach them — the arm admits a legitimate
    // non-owner, so the outsider's 404 is about the missing role and not about
    // "only the owner can ever read".
    let (_collab_id, collab) = create_member_token(&server, &admin, "byteviewer").await;
    let share = server
        .client
        .post(server.api_url(&format!("/projects/{sid}/shares")))
        .bearer_auth(&admin)
        .json(&json!({ "email": "byteviewer@txresbench.test", "permission_level": "viewer" }))
        .send()
        .await
        .expect("share project");
    assert!(share.status().is_success(), "share: {}", share.status());
    let share_id = share.json::<Value>().await.expect("share json")["id"]
        .as_str()
        .expect("share id")
        .to_string();
    let acc = server
        .client
        .post(server.api_url(&format!("/project-shares/{share_id}/accept")))
        .bearer_auth(&collab)
        .send()
        .await
        .expect("accept share");
    assert!(acc.status().is_success(), "accept share: {}", acc.status());
    assert_surfaces(
        &server,
        Some(&collab),
        &fx,
        200,
        "viewer-shared collaborator",
    )
    .await;

    // Unauthenticated → 401 on every surface (the route permission extractor, ahead
    // of the gate — asserted so an anonymous read can never regress to a 404-shaped
    // "not visible" that a client would retry).
    assert_surfaces(&server, None, &fx, 401, "anonymous").await;
}

// ───────────────────────── the DATASET arm ─────────────────────────

/// A dataset-scoped artifact is readable by the dataset OWNER and by a USER-share
/// recipient, and by nobody else. Unsharing takes the bytes away again.
#[tokio::test]
async fn dataset_scoped_artifact_bytes_are_gated_by_dataset_visibility() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    // The dataset OWNER is a plain member, not the admin — so "the owner can read"
    // is a statement about `datasets.owner_id`, not about holding `*`.
    let (owner_id, owner) = create_member_token(&server, &admin, "dsowner").await;
    let dataset_id =
        Uuid::parse_str(&crate::dataset::create_dataset(&server, &owner, "byte-authz-ds").await)
            .unwrap();
    let fx = seed_dataset_fixture(&server, dataset_id).await;
    assert_ne!(owner_id, Uuid::nil());

    // POSITIVE CONTROL — the dataset owner reads all three surfaces.
    assert_surfaces(&server, Some(&owner), &fx, 200, "dataset owner").await;

    // A member with no share on this dataset — the arm's negative case.
    let (sharee_id, sharee) = create_member_token(&server, &admin, "dssharee").await;
    assert_surfaces(&server, Some(&sharee), &fx, 404, "non-shared member").await;

    // …and the ADMIN, who holds every RBAC permission, is likewise refused: dataset
    // visibility is ownership+shares, not a capability, so `*` is not a master key
    // to another user's bytes.
    assert_surfaces(
        &server,
        Some(&admin),
        &fx,
        404,
        "admin who is not the dataset owner",
    )
    .await;

    // Share it to that member (`principal_type: user`) → the same URLs now answer
    // 200 with the same bytes. Nothing about the artifact changed; only the share.
    let share = server
        .client
        .post(server.api_url(&format!("/datasets/{dataset_id}/shares")))
        .bearer_auth(&owner)
        .json(&json!({ "principal_type": "user", "principal_id": sharee_id, "role": "view" }))
        .send()
        .await
        .expect("create user share");
    assert_eq!(share.status().as_u16(), 201, "share created");
    let share_id = share.json::<Value>().await.expect("share json")["id"]
        .as_str()
        .expect("share id")
        .to_string();
    assert_surfaces(&server, Some(&sharee), &fx, 200, "user-share recipient").await;

    // Unshare → the bytes go away again. A gate that granted on first read and
    // cached would pass every assertion above and fail here.
    let un = server
        .client
        .delete(server.api_url(&format!("/datasets/{dataset_id}/shares/{share_id}")))
        .bearer_auth(&owner)
        .send()
        .await
        .expect("delete share");
    assert_eq!(un.status().as_u16(), 204, "unshare");
    assert_surfaces(
        &server,
        Some(&sharee),
        &fx,
        404,
        "member after the share was revoked",
    )
    .await;

    // Unauthenticated → 401.
    assert_surfaces(&server, None, &fx, 401, "anonymous").await;
}

/// The GROUP-share leg of the dataset arm: `require_dataset_read` resolves the
/// acting user's group memberships inline, so a member of a group the dataset is
/// shared with reads the bytes — and a member of NO such group does not.
#[tokio::test]
async fn dataset_scoped_artifact_bytes_are_gated_by_group_share() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    let (_owner_id, owner) = create_member_token(&server, &admin, "gsowner").await;
    let dataset_id =
        Uuid::parse_str(&crate::dataset::create_dataset(&server, &owner, "group-byte-ds").await)
            .unwrap();
    let fx = seed_dataset_fixture(&server, dataset_id).await;
    assert_surfaces(&server, Some(&owner), &fx, 200, "dataset owner").await;

    // A dedicated group with NO RBAC permissions of its own — so a 200 below can
    // only come from the SHARE, never from a capability the group carries. The
    // `/groups` HTTP surface is stripped on this node; create/assign/deactivate
    // go through the SDK repositories over the per-test DB pool.
    let pool = pool_for(&server).await;
    let group_id = crate::common::group_create(&pool, "byte-authz-group", vec![])
        .await
        .to_string();

    let (member_id, member) = create_member_token(&server, &admin, "gsmember").await;
    let (_stranger_id, stranger) = create_member_token(&server, &admin, "gsstranger").await;
    crate::common::group_assign(
        &pool,
        member_id,
        Uuid::parse_str(&group_id).expect("group id is a uuid"),
    )
    .await;

    // Before the share, group membership alone grants nothing.
    assert_surfaces(
        &server,
        Some(&member),
        &fx,
        404,
        "group member, dataset not yet shared",
    )
    .await;

    let share = server
        .client
        .post(server.api_url(&format!("/datasets/{dataset_id}/shares")))
        .bearer_auth(&owner)
        .json(&json!({ "principal_type": "group", "principal_id": group_id, "role": "view" }))
        .send()
        .await
        .expect("create group share");
    assert_eq!(share.status().as_u16(), 201, "group share created");

    // The group member now reads the bytes …
    assert_surfaces(&server, Some(&member), &fx, 200, "group-share recipient").await;
    // … and a member of NO group does not. This is the group arm's own negative
    // control: without it, a predicate that ignored `user_groups` and admitted
    // everyone once ANY group share existed would still pass the line above.
    assert_surfaces(
        &server,
        Some(&stranger),
        &fx,
        404,
        "user outside the shared group",
    )
    .await;
}

/// **Deactivating a group is a revocation, and it has to mean the same thing at
/// every gate.**
///
/// `require_dataset_read` is a hand-copy of `DatasetRepository::is_visible_to`, and
/// it had drifted from it in exactly the way a duplicated authorization predicate
/// drifts: silently, on a clause nobody re-read. Every caller on the dataset side
/// passes group ids filtered by `permissions::active_group_ids` — ACTIVE groups only
/// — while this copy joined `user_groups` alone. So an administrator who disabled a
/// group revoked its members from the dataset's own endpoints and left them reading
/// the dataset's ARTIFACT BYTES, which is the surface that actually carries the data.
///
/// The first half is the negative control: while the group is active the member gets
/// `200` on both surfaces, so the second half's double-refusal is the revocation
/// taking effect and not a fixture that never granted anything. Asserting only the
/// post-deactivation refusal would pass against a fixture whose share never worked.
#[tokio::test]
async fn deactivating_a_shared_group_revokes_dataset_and_artifact_reads_together() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    let (_owner_id, owner) = create_member_token(&server, &admin, "dgowner").await;
    let dataset_id =
        Uuid::parse_str(&crate::dataset::create_dataset(&server, &owner, "disabled-group-ds").await)
            .unwrap();
    let fx = seed_dataset_fixture(&server, dataset_id).await;

    // A group with NO RBAC permissions of its own, so a 200 can only come from the
    // SHARE. `projects::use` reaches the member through the seeded Users group that
    // `create_member_token` already puts them in — deactivating THIS group therefore
    // removes the share without removing the capability, which is what isolates the
    // predicate under test.
    let (member_id, member) = create_member_token(&server, &admin, "dgmember").await;
    let group_id = {
        let pool = pool_for(&server).await;
        let group_id = crate::common::group_create(&pool, "revoked-group", vec![])
            .await
            .to_string();
        crate::common::group_assign(
            &pool,
            member_id,
            Uuid::parse_str(&group_id).expect("group id is a uuid"),
        )
        .await;
        group_id
    };

    let share = server
        .client
        .post(server.api_url(&format!("/datasets/{dataset_id}/shares")))
        .bearer_auth(&owner)
        .json(&json!({ "principal_type": "group", "principal_id": group_id, "role": "view" }))
        .send()
        .await
        .expect("create group share");
    assert_eq!(share.status().as_u16(), 201, "group share created");

    let dataset_read = |tok: &str| {
        let c = server.client.clone();
        let url = server.api_url(&format!("/datasets/{dataset_id}"));
        let tok = tok.to_string();
        async move {
            c.get(url)
                .bearer_auth(tok)
                .send()
                .await
                .expect("dataset read")
                .status()
                .as_u16()
        }
    };

    // --- NEGATIVE CONTROL: an ACTIVE group share grants BOTH surfaces. ---
    assert_eq!(
        dataset_read(&member).await,
        200,
        "an active group share grants the dataset read"
    );
    assert_surfaces(&server, Some(&member), &fx, 200, "active group share").await;

    // --- Deactivate the group (the revocation). ---
    crate::common::group_deactivate(
        &pool_for(&server).await,
        Uuid::parse_str(&group_id).expect("group id is a uuid"),
    )
    .await;

    // The dataset module's own gate stops honouring the share …
    assert_eq!(
        dataset_read(&member).await,
        404,
        "a disabled group no longer grants the dataset read"
    );
    // … and so must the workstore's copy of the same predicate.
    assert_surfaces(
        &server,
        Some(&member),
        &fx,
        404,
        "member of a DEACTIVATED shared group",
    )
    .await;
}
