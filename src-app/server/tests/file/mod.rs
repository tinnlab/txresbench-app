//! The `ziee-file` HTTP surface (`file_routes`, merged under `/api` by
//! `modules::file`) — the **authorization** suite.
//!
//! ## What this file is about
//!
//! `modules::file::register_routes` merges the SDK's whole store-generic router
//! wholesale. Every one of those handlers resolved a file with nothing but
//! `files.user_id = <caller>` — no dataset, no account, no membership. Because
//! `files.user_id` is stamped with the **uploading actor**
//! (`ingest_bytes(&…, auth.user.id, …)`) and `files` carries no `account_id`,
//! a member removed from an organization kept, indefinitely:
//!
//! - `GET /api/files` — an ENUMERATION of every file they ever uploaded, which
//!   is how the attacker learns the ids for everything below;
//! - `GET /api/files/{id}/download`, `/raw`, `/versions/{v}/download` — the
//!   **bytes**;
//! - `GET /api/files/{id}`, `/versions`, `/head`, `/text`, `/preview`,
//!   `/thumbnail`, `/text-rects` — the metadata and derivatives;
//! - `POST /api/files/{id}/download-token` — a signed bearer capability for the
//!   bytes. CytoAnalyst mounts no route that redeems one today (the redeemer is
//!   another SDK host's), so gating the mint here is prophylactic rather than
//!   load-bearing — but an ungated mint would hand a removed member a durable
//!   key the moment such a route appeared, and the token, once minted, is not
//!   revocable;
//! - `POST /api/files/{id}/restore` and `DELETE /api/files/{id}` — MUTATION and
//!   DESTRUCTION of the organization's data.
//!
//! This is the same principal as #170 (`sandbox::inputs::file_readable_by`) on a
//! far more direct path: #170 closed the sandbox byte-staging gate, and its own
//! comment records that this surface was left open only because `sdk` is a
//! pinned submodule. It is now closed by an injected authorization seam
//! (`ziee_file::seams::FileAccessPolicy`), implemented app-side by
//! `modules::file::access::DatasetFileAccessPolicy`, which delegates to the ONE
//! predicate that already decides this question — `file_readable_by`.
//!
//! ## Why every deny here is paired with a positive control
//!
//! A deny-only assertion passes VACUOUSLY when the route 404s for an unrelated
//! reason, the app fails to boot, auth bounces, or the blob was never written.
//! So every deny below is paired, on the SAME fixture and through the SAME
//! route, with principals who MUST still be admitted:
//!
//! - **bob himself, one line BEFORE the removal** — the same request is shown
//!   flipping from `200` + exact bytes to `404` with nothing but the
//!   `account_members` DELETE in between. This is what proves the bytes were
//!   really on disk and really served: a fixture that never wrote a blob cannot
//!   produce the `200`.
//! - **dana** — a bare co-member who stays, on HER file in HER org dataset. She
//!   is the principal a careless "deny unless owner" fix would lock out.
//! - **bob's LOOSE file** — one he uploaded to a dataset in his own PERSONAL
//!   account, which never belonged to the org. After removal he must still
//!   reach it. This is the legitimate case #170 says the obvious patch breaks,
//!   and it is the control that distinguishes "the seam authorizes" from "the
//!   seam denies everything".

use reqwest::multipart::{Form, Part};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use uuid::Uuid;

use super::account::{add_member, make_org_account, move_dataset_to_account, pool_for, setup_admin};


use crate::common::TestServer;

/// Distinct per-principal payloads so a byte assertion cannot pass by picking up
/// the wrong file's blob. DISTINCTNESS is the only property that matters — the
/// content is opaque to every assertion here, and `datatype::sniff` answers `None`
/// for a plain `.csv`, so nothing parses these. Deliberately NOT bio-domain column
/// names: this is the generic file surface, and borrowing dataset vocabulary for a
/// payload that means nothing is what the domain lint is right to flag.
const BOB_BYTES: &[u8] = b"id,value\nbob_row,7\n";
const DANA_BYTES: &[u8] = b"id,value\ndana_row,9\n";
const LOOSE_BYTES: &[u8] = b"id,value\nloose_row,11\n";

/// Create a user AND log them in — the routes under test are all bearer-authed,
/// so every principal needs a real token, not just an id.
async fn user_with_token(
    server: &TestServer,
    admin: &str,
    username: &str,
) -> (Uuid, String) {
    let resp = server
        .client
        .post(server.api_url("/auth/register"))
        .bearer_auth(admin)
        .json(&json!({
            "username": username,
            "email": format!("{username}@cyto.test"),
            "password": "userPassw0rd!",
        }))
        .send()
        .await
        .expect("create user");
    assert_eq!(resp.status().as_u16(), 201, "create user {username}");
    let id = Uuid::parse_str(
        resp.json::<Value>()
            .await
            .expect("user json")["id"]
            .as_str()
            .expect("user id"),
    )
    .expect("user id is a uuid");

    let login = server
        .client
        .post(server.api_url("/auth/login"))
        .json(&json!({ "username": username, "password": "userPassw0rd!" }))
        .send()
        .await
        .expect("login");
    assert_eq!(login.status().as_u16(), 200, "login {username}");
    let body: Value = login.json().await.expect("login json");
    let token = body["access_token"]
        .as_str()
        .or_else(|| body["token"].as_str())
        .expect("access token")
        .to_string();

    (id, token)
}

/// Create a dataset and upload REAL BYTES into it through the real multipart
/// upload path, so the blob genuinely exists on disk. Returns `(dataset, file)`.
///
/// Going through the real route matters: a hand-seeded `files` row has no blob,
/// so `/download` would 404 at the storage layer and every deny assertion below
/// would pass for the wrong reason.
async fn dataset_with_uploaded_file(
    server: &TestServer,
    token: &str,
    name: &str,
    filename: &str,
    bytes: &'static [u8],
) -> (Uuid, Uuid) {
    let create = server
        .client
        .post(server.api_url("/datasets"))
        .bearer_auth(token)
        .json(&json!({ "name": name }))
        .send()
        .await
        .expect("create dataset");
    assert_eq!(create.status().as_u16(), 201, "create dataset {name}");
    let dataset = Uuid::parse_str(
        create.json::<Value>().await.expect("dataset json")["id"]
            .as_str()
            .expect("dataset id"),
    )
    .expect("dataset id is a uuid");

    let form = Form::new().part(
        "file",
        Part::bytes(bytes.to_vec()).file_name(filename.to_string()),
    );
    let up = server
        .client
        .post(server.api_url(&format!("/datasets/{dataset}/upload")))
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await
        .expect("upload file");
    assert_eq!(up.status().as_u16(), 200, "upload {filename}");
    let file = Uuid::parse_str(
        up.json::<Value>().await.expect("upload json")["file_id"]
            .as_str()
            .expect("file_id"),
    )
    .expect("file id is a uuid");

    (dataset, file)
}

/// The shared fixture. An ORG account `Lab` with alice(owner) / bob(member) /
/// dana(member).
///
/// - **bob** uploads `f_bob` into dataset `d_bob`, which is then moved into the
///   org — the org's data, contributed by bob.
/// - **bob** also uploads `f_loose` into `d_loose`, which STAYS in his personal
///   account — the legitimate access that must survive removal.
/// - **dana** uploads `f_dana` into `d_dana`, also moved into the org — the
///   still-a-member control.
///
/// `remove_bob` then deletes exactly one row: bob's `account_members` row.
/// Every "after" assertion is therefore attributable to that one DELETE.
struct Fx {
    admin: String,
    pool: SqlitePool,
    /// the ORG dataset bob's file is linked to — the dataset branch's subject.
    d_bob: Uuid,
    org: Uuid,
    bob: Uuid,
    bob_tok: String,
    dana: Uuid,
    dana_tok: String,
    /// bob's file, in a dataset that belongs to the ORG.
    f_bob: Uuid,
    /// bob's file in a dataset that stayed in his PERSONAL account.
    f_loose: Uuid,
    /// dana's file, in a dataset that belongs to the ORG.
    f_dana: Uuid,
}

impl Fx {
    async fn build(server: &TestServer) -> Self {
        let admin = setup_admin(server).await;
        let pool = pool_for(server).await;

        let (alice, _alice_tok) = user_with_token(server, &admin, "alice").await;
        let (bob, bob_tok) = user_with_token(server, &admin, "bob").await;
        let (dana, dana_tok) = user_with_token(server, &admin, "dana").await;

        let dana_id = dana;
        let org = make_org_account(&pool, "Lab", alice).await;
        add_member(&pool, org, bob, "member").await;
        add_member(&pool, org, dana, "member").await;

        // bob contributes a file to what becomes the ORG's dataset.
        let (d_bob, f_bob) =
            dataset_with_uploaded_file(server, &bob_tok, "bobs-dataset", "bob.csv", BOB_BYTES)
                .await;
        move_dataset_to_account(&pool, d_bob, org).await;

        // bob's PERSONAL dataset — never moved, never the org's.
        let (_d_loose, f_loose) = dataset_with_uploaded_file(
            server,
            &bob_tok,
            "bobs-personal-dataset",
            "loose.csv",
            LOOSE_BYTES,
        )
        .await;

        // dana, a bare member who stays, contributes to the org too.
        let (d_dana, f_dana) =
            dataset_with_uploaded_file(server, &dana_tok, "danas-dataset", "dana.csv", DANA_BYTES)
                .await;
        move_dataset_to_account(&pool, d_dana, org).await;

        Self {
            admin,
            pool,
            d_bob,
            org,
            bob,
            bob_tok,
            dana: dana_id,
            dana_tok,
            f_bob,
            f_loose,
            f_dana,
        }
    }

    /// Delete EXACTLY bob's membership row — the whole offboarding event.
    async fn remove_bob(&self) {
        let done = sqlx::query("DELETE FROM account_members WHERE account_id = $1 AND user_id = $2")
            .bind(self.org)
            .bind(self.bob)
            .execute(&self.pool)
            .await
            .expect("remove bob");
        assert_eq!(
            done.rows_affected(),
            1,
            "the fixture must actually have had bob as a member — otherwise every \
             deny below would pass vacuously"
        );
    }

    /// `GET <path>` as `token`, returning `(status, body_bytes)`.
    async fn get(&self, server: &TestServer, token: &str, path: &str) -> (u16, Vec<u8>) {
        let resp = server
            .client
            .get(server.api_url(path))
            .bearer_auth(token)
            .send()
            .await
            .unwrap_or_else(|e| panic!("GET {path}: {e}"));
        let status = resp.status().as_u16();
        let body = resp.bytes().await.expect("body").to_vec();
        (status, body)
    }
}

/// Every read surface `file_routes` mounts for a single file id, as
/// `(suffix, human name)`. Enumerated explicitly rather than derived, so that
/// adding a route to the SDK bundle without adding it here is a visible gap in
/// THIS list rather than a silent hole in the guard.
fn read_surfaces(file: Uuid) -> Vec<(String, &'static str)> {
    vec![
        (format!("/files/{file}"), "get metadata"),
        (format!("/files/{file}/download"), "download bytes"),
        (format!("/files/{file}/raw"), "raw bytes (inline)"),
        (format!("/files/{file}/preview"), "preview image"),
        (format!("/files/{file}/thumbnail"), "thumbnail"),
        (format!("/files/{file}/text"), "extracted text"),
        (
            format!("/files/{file}/text-rects?page=1&start=0&end=1"),
            "citation rects",
        ),
        (format!("/files/{file}/versions"), "version list"),
        (format!("/files/{file}/head"), "head version"),
        (format!("/files/{file}/versions/1"), "version metadata"),
        (
            format!("/files/{file}/versions/1/download"),
            "version bytes",
        ),
        (format!("/files/{file}/versions/1/preview"), "version preview"),
        (format!("/files/{file}/versions/1/text"), "version text"),
    ]
}

/// TEST-1 [acceptance] [invariant: INV-1, INV-4] — **the bytes**. The headline exploit:
/// a removed member downloading the organization's data through the plain
/// download route.
///
/// The pre-removal leg is load-bearing: it asserts `200` AND the EXACT payload,
/// which is the only thing that proves the blob was really written and really
/// served. Without it, the post-removal `404` would be indistinguishable from a
/// fixture that never produced any bytes at all.
#[tokio::test]
async fn removed_member_cannot_download_the_bytes_they_uploaded() {
    let server = TestServer::spawn().await;
    let fx = Fx::build(&server).await;
    let path = format!("/files/{}/download", fx.f_bob);

    let (status, body) = fx.get(&server, &fx.bob_tok, &path).await;
    assert_eq!(
        status, 200,
        "precondition: a current member downloads the file he uploaded"
    );
    assert_eq!(
        body, BOB_BYTES,
        "precondition: and gets the REAL bytes — the blob is genuinely on disk"
    );

    fx.remove_bob().await;

    let (status, body) = fx.get(&server, &fx.bob_tok, &path).await;
    assert_eq!(
        status, 404,
        "a REMOVED member must not download the org's bytes (was 200 + the payload \
         before the seam: `files.user_id = bob` was the whole authorization)"
    );
    assert_ne!(
        body, BOB_BYTES,
        "and the payload must not leak in the error body"
    );

    // POSITIVE CONTROLS on the same fixture, after the same removal.
    let (status, body) = fx
        .get(&server, &fx.dana_tok, &format!("/files/{}/download", fx.f_dana))
        .await;
    assert_eq!(
        status, 200,
        "positive control: a current bare co-member still downloads her own file — \
         the route works, the app booted, auth passes"
    );
    assert_eq!(body, DANA_BYTES, "positive control: and gets her real bytes");

    let (status, body) = fx
        .get(&server, &fx.bob_tok, &format!("/files/{}/download", fx.f_loose))
        .await;
    assert_eq!(
        status, 200,
        "positive control: bob still reaches the file in his own PERSONAL dataset — \
         removal from the org revoked the org's data, not everything he owns"
    );
    assert_eq!(body, LOOSE_BYTES, "positive control: and its real bytes");
}

/// TEST-2 [acceptance] [invariant: INV-1] — **enumeration**. `GET /api/files`
/// filtered on `files.user_id` alone, so it listed every file the removed member
/// had ever uploaded. Closing download while leaving this open would still tell
/// the attacker exactly what exists.
#[tokio::test]
async fn removed_member_cannot_enumerate_the_files_they_uploaded() {
    let server = TestServer::spawn().await;
    let fx = Fx::build(&server).await;

    async fn listed(fx: &Fx, server: &TestServer, token: &str) -> (Vec<Uuid>, i64) {
        let (status, body) = fx.get(server, token, "/files?page=1&per_page=100").await;
        assert_eq!(status, 200, "the list route answers");
        let v: Value = serde_json::from_slice(&body).expect("list json");
        let ids = v["files"]
            .as_array()
            .expect("files array")
            .iter()
            .map(|f| Uuid::parse_str(f["id"].as_str().expect("file id")).unwrap())
            .collect();
        (ids, v["total"].as_i64().expect("total"))
    }

    let (ids, total) = listed(&fx, &server, &fx.bob_tok).await;
    assert!(
        ids.contains(&fx.f_bob),
        "precondition: a current member enumerates the file he uploaded"
    );
    assert_eq!(total, 2, "precondition: bob has exactly his two files");

    fx.remove_bob().await;

    let (ids, total) = listed(&fx, &server, &fx.bob_tok).await;
    assert!(
        !ids.contains(&fx.f_bob),
        "a REMOVED member must not enumerate the org's file (`:118` filtered on \
         user_id alone — this is how the attacker found the ids)"
    );
    assert!(
        ids.contains(&fx.f_loose),
        "positive control: his own personal file is still listed — the list is \
         filtered, not emptied"
    );
    assert_eq!(
        total, 1,
        "the TOTAL must drop too: a count that still says 2 leaks the existence of \
         a file the page no longer shows"
    );

    let (ids, total) = listed(&fx, &server, &fx.dana_tok).await;
    assert!(
        ids.contains(&fx.f_dana),
        "positive control: a current co-member still enumerates her own file"
    );
    assert_eq!(total, 1, "positive control: and her total is intact");
}

/// TEST-3 [acceptance] [invariant: INV-1] — **every read surface**, not just
/// download. Metadata, derivatives, versions and the head all resolved the file
/// on the same bare-`user_id` predicate, so each was an independent leak.
#[tokio::test]
async fn removed_member_is_refused_on_every_file_read_surface() {
    let server = TestServer::spawn().await;
    let fx = Fx::build(&server).await;

    // PRECONDITION: as a current member, bob is admitted everywhere. A surface
    // that already refuses him here cannot prove anything after the removal, so
    // assert the admit first and let a mismatch fail loudly.
    for (path, name) in read_surfaces(fx.f_bob) {
        let (status, _) = fx.get(&server, &fx.bob_tok, &path).await;
        assert_ne!(
            status, 404,
            "precondition: a current member reaches `{name}` ({path})"
        );
    }

    fx.remove_bob().await;

    for (path, name) in read_surfaces(fx.f_bob) {
        let (status, _) = fx.get(&server, &fx.bob_tok, &path).await;
        assert_eq!(
            status, 404,
            "a REMOVED member must be refused on `{name}` ({path})"
        );
    }

    // POSITIVE CONTROL: the identical surface list, same removal, for a co-member
    // who still has standing — proves the guard discriminates rather than
    // blanket-denying every file route.
    for (path, name) in read_surfaces(fx.f_dana) {
        let (status, _) = fx.get(&server, &fx.dana_tok, &path).await;
        assert_ne!(
            status, 404,
            "positive control: a current co-member still reaches `{name}` ({path})"
        );
    }
    for (path, name) in read_surfaces(fx.f_loose) {
        let (status, _) = fx.get(&server, &fx.bob_tok, &path).await;
        assert_ne!(
            status, 404,
            "positive control: bob still reaches `{name}` on his personal file ({path})"
        );
    }
}

/// TEST-4 [acceptance] [invariant: INV-1] — **the write surfaces**. A removed
/// member could DELETE the organization's file outright, and `restore` could
/// rewrite its head. Deny is asserted together with the row SURVIVING: a
/// `DELETE` that returns 404 having already destroyed the row would satisfy a
/// status-only assertion.
#[tokio::test]
async fn removed_member_can_neither_delete_nor_restore_the_file() {
    let server = TestServer::spawn().await;
    let fx = Fx::build(&server).await;

    // PRECONDITION, inside this test: bob reaches the file while he is still a
    // member, so the refusal below is visibly the removal's doing and not a
    // fixture that never produced a reachable file.
    let (status, _) = fx
        .get(&server, &fx.bob_tok, &format!("/files/{}", fx.f_bob))
        .await;
    assert_eq!(status, 200, "precondition: a current member reaches the file");

    fx.remove_bob().await;

    let resp = server
        .client
        .delete(server.api_url(&format!("/files/{}", fx.f_bob)))
        .bearer_auth(&fx.bob_tok)
        .send()
        .await
        .expect("delete");
    assert_eq!(
        resp.status().as_u16(),
        404,
        "a REMOVED member must not DELETE the org's file"
    );

    let still_there: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM files WHERE id = $1)")
            .bind(fx.f_bob)
            .fetch_one(&fx.pool)
            .await
            .expect("existence probe");
    assert!(
        still_there,
        "and the row must SURVIVE — a 404 returned after the delete already \
         succeeded is not a refusal"
    );

    let resp = server
        .client
        .post(server.api_url(&format!("/files/{}/restore", fx.f_bob)))
        .bearer_auth(&fx.bob_tok)
        .json(&json!({ "version": 1 }))
        .send()
        .await
        .expect("restore");
    assert_eq!(
        resp.status().as_u16(),
        404,
        "nor may they restore a version of it"
    );

    // POSITIVE CONTROL for RESTORE: dana restores HER file through the same
    // route. Without this, the restore deny above would pass identically if the
    // route were never mounted — axum answers an unmatched path with the very
    // 404 being asserted.
    let resp = server
        .client
        .post(server.api_url(&format!("/files/{}/restore", fx.f_dana)))
        .bearer_auth(&fx.dana_tok)
        .json(&json!({ "version": 1 }))
        .send()
        .await
        .expect("restore dana");
    assert_eq!(
        resp.status().as_u16(),
        200,
        "positive control: restore IS mounted and serves a principal with standing"
    );

    // POSITIVE CONTROL: dana deletes HER file through the same route, proving
    // DELETE is reachable and functional for a principal with standing.
    let resp = server
        .client
        .delete(server.api_url(&format!("/files/{}", fx.f_dana)))
        .bearer_auth(&fx.dana_tok)
        .send()
        .await
        .expect("delete dana");
    assert_eq!(
        resp.status().as_u16(),
        204,
        "positive control: a current co-member still deletes her own file"
    );
}

/// TEST-5 [acceptance] [invariant: INV-1] — **the download token**. This route
/// mints a signed bearer capability for the bytes.
///
/// Scope of the claim, since it is easy to overstate: cytoanalyst mounts no route
/// that REDEEMS such a token (the redeemer belongs to another SDK host), so the
/// gate is prophylactic here — it is not currently a path to bytes in this app.
/// It is gated anyway because a minted token is not revocable: it stays
/// redeemable until it expires, so an ungated mint is the one surface where a
/// removed member could take away something that outlives the revocation.
#[tokio::test]
async fn removed_member_cannot_mint_a_download_token() {
    let server = TestServer::spawn().await;
    let fx = Fx::build(&server).await;

    let mint = |file: Uuid, token: String| {
        let client = server.client.clone();
        let url = server.api_url(&format!("/files/{file}/download-token"));
        async move {
            client
                .post(url)
                .bearer_auth(token)
                .json(&json!({}))
                .send()
                .await
                .expect("download-token")
                .status()
                .as_u16()
        }
    };

    assert!(
        mint(fx.f_bob, fx.bob_tok.clone()).await < 400,
        "precondition: a current member may mint a token for his own file"
    );

    fx.remove_bob().await;

    assert_eq!(
        mint(fx.f_bob, fx.bob_tok.clone()).await,
        404,
        "a REMOVED member must not mint a download token for the org's file"
    );
    assert!(
        mint(fx.f_dana, fx.dana_tok.clone()).await < 400,
        "positive control: a current co-member still mints one for her own file"
    );
    assert!(
        mint(fx.f_loose, fx.bob_tok.clone()).await < 400,
        "positive control: and bob still mints one for his personal file"
    );
}

/// TEST-6 [acceptance] [invariant: INV-3] — **no legitimate access lost.**
///
/// #170 records that the obvious patch — gate or drop the `files.user_id` branch
/// — "breaks the legitimate case": "a user's own uploaded file, in no dataset at
/// all, would stop being readable by their own sandbox". The seam must preserve
/// that branch exactly, and preserve it across the WHOLE read surface, not just
/// the one route the headline exploit used.
///
/// Both shapes of legitimate access are driven here after the removal: a file in
/// a dataset in the uploader's own PERSONAL account, and a file linked to no
/// dataset at all.
#[tokio::test]
async fn removal_from_an_org_does_not_touch_the_uploaders_own_files() {
    let server = TestServer::spawn().await;
    let fx = Fx::build(&server).await;

    // A genuinely LOOSE file: uploaded, then unlinked from every dataset, so
    // only the `NOT EXISTS (dataset_files)` branch can admit it.
    sqlx::query("DELETE FROM dataset_files WHERE file_id = $1")
        .bind(fx.f_loose)
        .execute(&fx.pool)
        .await
        .expect("unlink the loose file");

    fx.remove_bob().await;

    for (path, name) in read_surfaces(fx.f_loose) {
        let (status, _) = fx.get(&server, &fx.bob_tok, &path).await;
        assert_ne!(
            status, 404,
            "a file in NO dataset stays readable by its uploader — `{name}` ({path}). \
             This is the exact case #170 says the obvious patch breaks."
        );
    }

    let (status, body) = fx
        .get(&server, &fx.bob_tok, &format!("/files/{}/download", fx.f_loose))
        .await;
    assert_eq!(status, 200, "and its bytes are still served");
    assert_eq!(body, LOOSE_BYTES, "with the real payload, not an empty 200");

    // It is still enumerable, so the list did not simply empty out either.
    let (status, body) = fx.get(&server, &fx.bob_tok, "/files?page=1&per_page=100").await;
    assert_eq!(status, 200);
    let v: Value = serde_json::from_slice(&body).expect("list json");
    let ids: Vec<Uuid> = v["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| Uuid::parse_str(f["id"].as_str().unwrap()).unwrap())
        .collect();
    assert!(ids.contains(&fx.f_loose), "the loose file is still listed");
    assert!(
        !ids.contains(&fx.f_bob),
        "while the org file it sits beside is not — the filter discriminates"
    );
}

/// TEST-7 [acceptance] [invariant: INV-2] — **personal accounts are unaffected.**
///
/// #147's INV-11c: the transform is behaviour-preserving for a personal account,
/// whose single member IS the owner. A solo user who has never been near an
/// organization must see the file surface behave exactly as it did before the
/// seam existed.
#[tokio::test]
async fn a_solo_users_personal_account_is_unaffected() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let (_solo, solo_tok) = user_with_token(&server, &admin, "solo").await;

    let (_ds, file) = dataset_with_uploaded_file(
        &server,
        &solo_tok,
        "solos-dataset",
        "solo.csv",
        BOB_BYTES,
    )
    .await;

    let fx = Fx {
        admin: admin.clone(),
        pool,
        d_bob: Uuid::nil(),
        org: Uuid::nil(),
        bob: Uuid::nil(),
        bob_tok: solo_tok.clone(),
        dana: Uuid::nil(),
        dana_tok: solo_tok.clone(),
        f_bob: file,
        f_loose: file,
        f_dana: file,
    };

    for (path, name) in read_surfaces(file) {
        let (status, _) = fx.get(&server, &solo_tok, &path).await;
        assert_ne!(
            status, 404,
            "a solo user in only their personal account reaches `{name}` ({path}) — \
             their account's sole member IS the owner, so the dataset branch admits \
             them exactly as before"
        );
    }

    let (status, body) = fx
        .get(&server, &solo_tok, &format!("/files/{file}/download"))
        .await;
    assert_eq!(status, 200, "and downloads");
    assert_eq!(body, BOB_BYTES, "the real bytes");

    let (status, body) = fx.get(&server, &solo_tok, "/files?page=1&per_page=100").await;
    assert_eq!(status, 200);
    let v: Value = serde_json::from_slice(&body).expect("list json");
    assert_eq!(v["total"].as_i64(), Some(1), "and enumerates their one file");

    // The write surfaces too — the seam must not have quietly made a solo user
    // read-only over their own data.
    let resp = server
        .client
        .delete(server.api_url(&format!("/files/{file}")))
        .bearer_auth(&solo_tok)
        .send()
        .await
        .expect("delete");
    assert_eq!(
        resp.status().as_u16(),
        204,
        "and still deletes their own file"
    );
}

/// TEST-9 [acceptance] [invariant: INV-6] — **one predicate, not two.**
///
/// On the READ kinds, the seam and `sandbox::inputs::file_readable_by` must answer
/// identically for every principal × file, because they are the same question and,
/// since ITEM-8, literally the same SQL. This is the lock-step guard, mirroring
/// `require_dataset_read_matches_is_visible_to`: the divergence it exists to
/// prevent has already happened once on this very predicate (the missing
/// `groups.is_active` filter that `841e6111` fixed as the sixth hand-copy).
///
/// **Scoped to the READ kinds deliberately, and the scoping is itself asserted.**
/// An earlier version of this test required agreement across ALL FOUR access
/// kinds, which was correct only while the policy answered all four with the read
/// predicate. When `Write`/`Delete` were split onto edit standing (the owner's
/// "a view grant must never destroy data"), this test went RED on a legitimate
/// disagreement — a bare co-member may READ a file in the account's dataset and
/// may NOT delete it. The failure was the test's stale premise, not a defect, so
/// rather than narrow it silently the divergence is now asserted as a POSITIVE
/// claim below: at least one principal must be readable-but-not-writable, which is
/// what proves the split is real rather than a no-op.
///
/// Asserting agreement alone would be vacuous if both sides always said the same
/// thing — so the matrix is checked to contain BOTH verdicts before the agreement
/// is asserted.
#[tokio::test]
async fn the_seam_and_file_readable_by_never_disagree() {
    use cytoanalyst::modules::file::access::DatasetFileAccessPolicy;
    use cytoanalyst::modules::sandbox::inputs::file_readable_by;
    use ziee_file::seams::{FileAccess, FileAccessPolicy};

    let server = TestServer::spawn().await;
    let fx = Fx::build(&server).await;
    fx.remove_bob().await;

    let policy = DatasetFileAccessPolicy::new(fx.pool.clone());
    let principals = [("bob (removed)", fx.bob), ("dana (member)", fx.dana)];
    let files = [
        ("org file", fx.f_bob),
        ("personal file", fx.f_loose),
        ("dana's org file", fx.f_dana),
        ("absent", Uuid::new_v4()),
    ];

    let mut verdicts = Vec::new();
    let mut write_verdicts: Vec<(&str, &str, bool, bool)> = Vec::new();
    for (pname, principal) in principals {
        for (fname, file) in files {
            let via_predicate = file_readable_by(&fx.pool, file, principal).await.unwrap();
            for access in [FileAccess::ReadMetadata, FileAccess::ReadContent] {
                let via_seam = policy.can_access(principal, file, access).await.unwrap();
                assert_eq!(
                    via_seam, via_predicate,
                    "the seam and file_readable_by disagree for {pname} on {fname} \
                     ({access:?}) — two answers to one READ question is how the next \
                     hole gets made"
                );
            }

            // The WRITE kinds are answered by a different predicate on purpose, and
            // must never exceed the read answer: writable ⇒ readable, always.
            for access in [FileAccess::Write, FileAccess::Delete] {
                let via_seam = policy.can_access(principal, file, access).await.unwrap();
                assert!(
                    !via_seam || via_predicate,
                    "{pname} on {fname}: WRITABLE but not readable ({access:?}) — \
                     write standing must be a strict subset of read standing"
                );
                write_verdicts.push((pname, fname, via_predicate, via_seam));
            }

            // The batch path must agree with the point path too: `filter_readable`
            // is what gates enumeration, and a filter that drifts from `can_access`
            // would hide a file the caller can still fetch, or vice versa.
            let filtered = policy
                .filter(principal, &[file], FileAccess::ReadMetadata)
                .await
                .unwrap();
            assert_eq!(
                filtered.contains(&file),
                via_predicate,
                "filter_readable disagrees with the point check for {pname} on {fname}"
            );

            verdicts.push(via_predicate);
        }
    }

    // The BATCH path, with a genuinely multi-id candidate set. Above,
    // `filter_readable` only ever saw one-element slices — which is exactly where
    // a batch/point divergence would hide, since a batch query can drop or
    // duplicate rows in ways a single-row query never reveals.
    let all: Vec<Uuid> = files.iter().map(|(_, f)| *f).collect();
    for (pname, principal) in principals {
        let batch = policy
            .filter(principal, &all, FileAccess::ReadMetadata)
            .await
            .unwrap();
        for (fname, file) in files {
            let point = file_readable_by(&fx.pool, file, principal).await.unwrap();
            assert_eq!(
                batch.contains(&file),
                point,
                "batch filter_readable disagrees with the point check for {pname} \
                 on {fname} when asked about {} files at once",
                all.len()
            );
        }
        assert!(
            batch.len() <= all.len() && batch.iter().collect::<std::collections::HashSet<_>>().len() == batch.len(),
            "the batch answer must be a duplicate-free subset of what it was asked about"
        );
    }

    assert!(
        verdicts.iter().any(|v| *v) && verdicts.iter().any(|v| !*v),
        "the matrix must contain BOTH admits and denies — agreement between two \
         predicates that always say the same thing proves nothing"
    );

    // THE SPLIT IS REAL, asserted rather than assumed. At least one entry must be
    // readable-but-NOT-writable; without this the read/write split could be a
    // no-op (both predicates answering identically) and every assertion above
    // would still pass. `dana` on `f_bob` is that entry: a bare account member may
    // read a file in the account's dataset and may not destroy it.
    //
    // NAMING, so it is not "improved" back: these are MATRIX entries — rows of
    // `write_verdicts` — and the obvious word for them collides with a bio-domain
    // noun the repo's domain lint scans for. The lint cannot distinguish a table
    // entry from a biological one and never will, so the neutral word stands.
    let split_entries: Vec<_> = write_verdicts
        .iter()
        .filter(|(_, _, readable, writable)| *readable && !*writable)
        .collect();
    assert!(
        !split_entries.is_empty(),
        "no principal is readable-but-not-writable, so the read/write split is \
         indistinguishable from a single predicate: {write_verdicts:?}"
    );
}

/// TEST-15 — **the owner-scope conjunct is load-bearing, and pinned.**
///
/// dana has FULL dataset standing on `f_bob`: same org, same account, same
/// dataset. `readable_file_ids` returns **true** for her on that file. The only
/// thing keeping her out is the `files.user_id` conjunct the store applies inside
/// `FileContext::authorized_file`.
///
/// Nothing else in this suite pins that. Every other test varies the POLICY's
/// answer, so all of them would stay green if `authorized_file` were ever
/// "simplified" to trust the policy alone — and that simplification would hand
/// every co-member read and DELETE over every other member's files, silently.
/// The SDK pins the conjunct under a permissive stub; this pins it where the
/// policy is genuinely permissive, which is the case that matters.
#[tokio::test]
async fn a_co_member_with_full_dataset_standing_still_cannot_reach_anothers_file() {
    use cytoanalyst::modules::file::access::readable_file_ids;

    let server = TestServer::spawn().await;
    let fx = Fx::build(&server).await;

    // The policy really does admit her — so the 404s below are the owner scope's
    // doing and nothing else. Without this line the test would be indistinguishable
    // from "dana has no standing either".
    let admitted = readable_file_ids(&fx.pool, fx.dana, &[fx.f_bob]).await.unwrap();
    assert_eq!(
        admitted,
        vec![fx.f_bob],
        "precondition: the dataset policy ADMITS dana on bob's file — she is a \
         co-member of the account that owns the dataset it is linked to"
    );

    for (path, name) in read_surfaces(fx.f_bob) {
        let (status, _) = fx.get(&server, &fx.dana_tok, &path).await;
        assert_eq!(
            status, 404,
            "a co-member with full dataset standing must STILL be refused another \
             member's file on `{name}` ({path}) — the store's `files.user_id` \
             conjunct is what refuses her, and it must not be optimized away"
        );
    }

    let resp = server
        .client
        .delete(server.api_url(&format!("/files/{}", fx.f_bob)))
        .bearer_auth(&fx.dana_tok)
        .send()
        .await
        .expect("delete");
    assert_eq!(
        resp.status().as_u16(),
        404,
        "and she certainly must not DELETE it"
    );
    let alive: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM files WHERE id = $1)")
        .bind(fx.f_bob)
        .fetch_one(&fx.pool)
        .await
        .expect("existence probe");
    assert!(alive, "the row survived her DELETE");

    // POSITIVE CONTROL: the same principal, the same routes, HER file → reachable.
    for (path, name) in read_surfaces(fx.f_dana) {
        let (status, _) = fx.get(&server, &fx.dana_tok, &path).await;
        assert_ne!(
            status, 404,
            "positive control: dana reaches `{name}` on her OWN file ({path})"
        );
    }
}

// ===========================================================================
// Parent-side proofs of properties the SDK suite also covers.
//
// `ziee-file` lives in a submodule, so its own tests are invisible to this
// repo's diff — and an id whose evidence nothing here can see is exactly the
// inherited PASS the lifecycle's A11 check exists to refuse. These assert the
// same claims from the app side, where they can be seen and, in several cases,
// where they are the more meaningful place to assert them anyway.
// ===========================================================================

/// The generated OpenAPI document, as the UI client is built from.
fn generated_openapi() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../ui/openapi/openapi.json");
    let raw = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("read generated openapi at {path}: {e}"));
    serde_json::from_str(&raw).expect("openapi.json parses")
}

/// Every `/api/files…` OPERATION the generated spec exposes, as `METHOD path`.
///
/// Methods, not bare path templates: `/api/files/{file_id}` already carries GET
/// and DELETE, so a new method merged onto an EXISTING path adds no new path key.
/// Comparing templates alone would let such a route mount unswept while this
/// guard stayed green — the same blind spot the SDK-side guard had.
fn spec_file_operations() -> Vec<String> {
    let doc = generated_openapi();
    let mut ops: Vec<String> = Vec::new();
    for (path, item) in doc["paths"].as_object().expect("paths object").iter() {
        if path != "/api/files" && !path.starts_with("/api/files/") {
            continue;
        }
        for (method, op) in item.as_object().expect("path item").iter() {
            // Path-level siblings of the operation objects (`parameters`,
            // `summary`, `$ref`, …) are not methods. An operation always carries
            // an operationId in this spec, which is what distinguishes them.
            if op.get("operationId").is_some() {
                ops.push(format!("{} {}", method.to_uppercase(), path));
            }
        }
    }
    ops.sort();
    ops
}

/// TEST-11 — the store's pre-existing contract still holds THROUGH the app: an
/// unrelated principal is refused everywhere, and the uploader still gets real
/// bytes.
///
/// **What this does NOT prove, stated so the label cannot mislead:** `stranger`
/// has no membership and no share, so the dataset POLICY refuses them too —
/// delete the store's `files.user_id` conjunct entirely and every assertion here
/// still passes. The discriminating principal for that conjunct is a co-member
/// with full dataset standing who is not the uploader, and that is
/// `a_co_member_with_full_dataset_standing_still_cannot_reach_anothers_file`
/// (TEST-15), which asserts the policy ADMITS her before asserting the routes
/// refuse her.
///
/// What this one is for is the other half: the crate's own behaviour — foreign
/// principal → 404 on every surface, and the download path still serving the
/// exact stored bytes — surviving the seam, asserted where a regression would
/// actually reach production rather than only inside the submodule's suite.
#[tokio::test]
async fn the_stores_owner_scoping_still_holds_through_the_app() {
    let server = TestServer::spawn().await;
    let fx = Fx::build(&server).await;
    let (_sid, stranger_tok) = user_with_token(&server, &fx.admin, "stranger").await;

    for (path, name) in read_surfaces(fx.f_bob) {
        let (status, _) = fx.get(&server, &stranger_tok, &path).await;
        assert_eq!(
            status, 404,
            "a stranger must be refused `{name}` ({path}) — owner scope, unchanged"
        );
    }

    // POSITIVE CONTROL: bob, the uploader, still reaches it (he is still a
    // member here — no removal has happened in this test).
    let (status, body) = fx
        .get(&server, &fx.bob_tok, &format!("/files/{}/download", fx.f_bob))
        .await;
    assert_eq!(status, 200, "positive control: the uploader still downloads");
    assert_eq!(body, BOB_BYTES, "positive control: and gets the real bytes");
}

/// TEST-13 — the generated contract did not move.
///
/// The SDK bump rewired every file handler. A consumer must not be able to tell:
/// the operationId set the UI client is generated from is pinned here, so a
/// contract drift shows up as a failing test in this repo and not as a surprise
/// diff in someone's regenerated client.
#[test]
fn the_generated_file_operation_ids_are_unchanged() {
    let doc = generated_openapi();
    // Ids paired with their METHOD and PATH: collecting bare ids would let the GET
    // and DELETE operations on `/api/files/{file_id}` swap places unnoticed.
    let mut ids: Vec<String> = Vec::new();
    for (path, item) in doc["paths"].as_object().expect("paths").iter() {
        if path != "/api/files" && !path.starts_with("/api/files/") {
            continue;
        }
        for (method, op) in item.as_object().expect("path item").iter() {
            if let Some(id) = op.get("operationId").and_then(|v| v.as_str()) {
                ids.push(format!("{} {} {}", method.to_uppercase(), path, id));
            }
        }
    }
    ids.sort();

    let mut expected: Vec<String> = vec![
        "GET /api/files File.list",
        "GET /api/files/{file_id} File.get",
        "DELETE /api/files/{file_id} File.delete",
        "GET /api/files/{file_id}/download File.download",
        "POST /api/files/{file_id}/download-token File.generateDownloadToken",
        "GET /api/files/{file_id}/head File.getHeadVersion",
        "GET /api/files/{file_id}/preview File.getPreview",
        "GET /api/files/{file_id}/raw File.getRaw",
        "POST /api/files/{file_id}/restore File.restore",
        "GET /api/files/{file_id}/text File.getTextContent",
        "GET /api/files/{file_id}/text-rects File.getTextRects",
        "GET /api/files/{file_id}/thumbnail File.getThumbnail",
        "GET /api/files/{file_id}/versions File.listVersions",
        "GET /api/files/{file_id}/versions/{version} File.getVersion",
        "GET /api/files/{file_id}/versions/{version}/download File.downloadVersion",
        "GET /api/files/{file_id}/versions/{version}/preview File.previewVersion",
        "GET /api/files/{file_id}/versions/{version}/text File.textVersion",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    expected.sort();
    assert_eq!(
        ids, expected,
        "the file surface's operationId set must be byte-identical across the \
         authorization change"
    );
}

/// TEST-16 — the surface list this file sweeps covers every file route the app
/// actually exposes.
///
/// Without this, `read_surfaces` is a list someone remembered to update: a route
/// added to the SDK bundle and forgotten here would be swept by nothing, and
/// every deny test would still pass while leaving it ungated. That is precisely
/// the failure this branch exists to fix, so the enumeration is pinned to the
/// generated spec rather than trusted.
#[test]
fn the_swept_surface_list_covers_every_exposed_file_route() {
    let nil = Uuid::nil();
    // `read_surfaces` is GET-only by construction.
    let mut swept: Vec<String> = read_surfaces(nil)
        .into_iter()
        .map(|(p, _)| {
            let path = p.split('?').next().unwrap().to_string();
            let path = format!("/api{}", path)
                .replace(&nil.to_string(), "{file_id}")
                .replace("/versions/1", "/versions/{version}");
            format!("GET {path}")
        })
        .collect();
    // Swept elsewhere in this file, by their own dedicated tests.
    swept.push("GET /api/files".to_string()); // TEST-2 (enumeration)
    swept.push("POST /api/files/{file_id}/restore".to_string()); // TEST-4
    swept.push("DELETE /api/files/{file_id}".to_string()); // TEST-4
    swept.push("POST /api/files/{file_id}/download-token".to_string()); // TEST-5
    swept.sort();
    swept.dedup();

    let exposed = spec_file_operations();
    assert_eq!(
        swept, exposed,
        "every exposed /api/files OPERATION must be swept by this suite.\n\
         Exposed but NOT swept (possibly ungated): {:?}\n\
         Swept but not exposed (stale): {:?}",
        exposed.iter().filter(|e| !swept.contains(e)).collect::<Vec<_>>(),
        swept.iter().filter(|s| !exposed.contains(s)).collect::<Vec<_>>(),
    );
}

/// TEST-14 — the filtered listing's paging and total are computed over the
/// FILTERED set, across page boundaries.
///
/// TEST-2 proves one revoked file leaves the list and the total. This proves the
/// arithmetic holds when the filter removes files from the MIDDLE of a multi-page
/// result: no short pages, no phantom total, no readable file lost between pages.
#[tokio::test]
async fn the_filtered_listing_pages_and_counts_over_the_filtered_set() {
    let server = TestServer::spawn().await;
    let fx = Fx::build(&server).await;

    // Four more personal files for bob, so after the removal he has 5 readable
    // (4 new + f_loose) and 1 revoked (f_bob) — enough to span pages.
    for i in 0..4 {
        dataset_with_uploaded_file(
            &server,
            &fx.bob_tok,
            &format!("bobs-personal-{i}"),
            &format!("p{i}.csv"),
            LOOSE_BYTES,
        )
        .await;
    }

    fx.remove_bob().await;

    let mut seen: Vec<Uuid> = Vec::new();
    let mut totals: Vec<i64> = Vec::new();
    for page in 1..=3 {
        let (status, body) = fx
            .get(&server, &fx.bob_tok, &format!("/files?page={page}&per_page=2"))
            .await;
        assert_eq!(status, 200);
        let v: Value = serde_json::from_slice(&body).expect("list json");
        totals.push(v["total"].as_i64().expect("total"));
        let page_files = v["files"].as_array().expect("files");
        // NO SHORT PAGES — asserted, not merely claimed. A page-then-filter
        // implementation returns a page shorter than `per_page` whenever the
        // filter removes a row from the middle; only checking the union would
        // miss it.
        let expected_len = if page < 3 { 2 } else { 1 };
        assert_eq!(
            page_files.len(),
            expected_len,
            "page {page} must be full ({expected_len}) — filtering happens before \
             paging, so no page is short except the last"
        );
        for f in page_files {
            seen.push(Uuid::parse_str(f["id"].as_str().unwrap()).unwrap());
        }
    }

    assert!(
        totals.iter().all(|t| *t == 5),
        "the total is the FILTERED count on every page, not the owner count: {totals:?}"
    );
    // Exact set, deduped: a paging bug that repeats one id while dropping another
    // still gives len() == 5 and still satisfies both `contains` checks.
    let mut unique = seen.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(
        unique.len(),
        seen.len(),
        "no id may appear on two pages: {seen:?}"
    );
    assert_eq!(seen.len(), 5, "paging yields exactly the readable files");
    assert!(
        !seen.contains(&fx.f_bob),
        "and the revoked org file appears on NO page"
    );
    assert!(
        seen.contains(&fx.f_loose),
        "while his personal files all still do"
    );
}

/// TEST-17 — `readable_file_ids` returns its answer in CANDIDATE order.
///
/// The seam's contract promises order preservation, and the SDK relies on it to
/// hand back a list it can page. Driven with a deliberately unsorted candidate
/// order and a withheld middle element, so neither input order nor sorted order
/// can pass by coincidence.
#[tokio::test]
async fn readable_file_ids_preserves_candidate_order() {
    use cytoanalyst::modules::file::access::readable_file_ids;

    let server = TestServer::spawn().await;
    let fx = Fx::build(&server).await;
    fx.remove_bob().await;

    // Order must be discriminated against BOTH plausible wrong answers: sorted-by-id
    // and the planner's arbitrary order. With only two admitted ids and random v4
    // UUIDs, "candidate order" and "sorted order" coincide half the time — a coin
    // flip, not a proof. So: three admitted ids, in an order deliberately chosen to
    // be neither ascending nor descending by id.
    // A third file dana can read, so the ordering has enough elements to be
    // discriminating (two ids coincide with sorted order half the time).
    let (d2, f_dana2) = dataset_with_uploaded_file(
        &server,
        &fx.dana_tok,
        "danas-second",
        "dana2.csv",
        DANA_BYTES,
    )
    .await;
    move_dataset_to_account(&fx.pool, d2, fx.org).await;

    let mut admitted = vec![fx.f_bob, fx.f_dana, f_dana2];
    admitted.sort(); // now ascending by id
    // Rotate into a non-monotone arrangement: [mid, high, low].
    let candidates = vec![admitted[1], admitted[2], admitted[0]];
    let got = readable_file_ids(&fx.pool, fx.dana, &candidates).await.unwrap();
    assert_eq!(
        got, candidates,
        "the readable subset comes back in CANDIDATE order — not ascending by id \
         (which would be {:?}) and not the planner's order",
        admitted
    );

    // And the filtering itself still discriminates: bob after removal keeps only
    // his personal file out of the same candidate set.
    let mixed = vec![fx.f_loose, fx.f_bob, fx.f_dana];
    let got = readable_file_ids(&fx.pool, fx.bob, &mixed).await.unwrap();
    assert_eq!(
        got,
        vec![fx.f_loose],
        "the revoked org file and another member's file are both dropped"
    );
}

/// TEST-18 — **the dataset branch stays in lock-step with the dataset gates.**
///
/// `readable_file_ids`' dataset disjunct is a hand-copy of the same union spelled
/// in `DatasetRepository::is_visible_to` and `workstore::authz::require_dataset_read`.
/// Promoting it to one shared literal removed the copy that existed between the
/// sandbox and HTTP paths — but it did NOT collapse it into those two, so the
/// drift INV-6 is about is still possible in the direction that has actually bitten
/// before: the missing `groups.is_active` filter `841e6111` fixed here was the
/// SIXTH divergence of exactly this union.
///
/// So this asserts, for a DATASET-LINKED file across a matrix of principals, that
/// "may read the file" and "may read its dataset" give the SAME answer — and
/// checks the matrix contains both verdicts, because agreement between two
/// predicates that always say the same thing proves nothing.
#[tokio::test]
async fn the_dataset_branch_agrees_with_the_dataset_read_gate() {
    use cytoanalyst::modules::file::access::readable_file_ids;
    use cytoanalyst::modules::workstore::authz::require_dataset_read;

    let server = TestServer::spawn().await;
    let fx = Fx::build(&server).await;

    // An ACTIVE-group sharee and a soon-to-be-DISABLED-group sharee.
    let (grouped, _t) = user_with_token(&server, &fx.admin, "grouped").await;
    let (stranger, _t2) = user_with_token(&server, &fx.admin, "outsider").await;
    let group: Uuid = sqlx::query_scalar(
        "INSERT INTO groups (id, name, description, permissions, is_active) \
         VALUES (randomblob(16), 'file-authz-lockstep', '', '{}', true) RETURNING id",
    )
    .fetch_one(&fx.pool)
    .await
    .expect("seed group");
    sqlx::query("INSERT INTO user_groups (user_id, group_id) VALUES ($1, $2)")
        .bind(grouped)
        .bind(group)
        .execute(&fx.pool)
        .await
        .expect("assign group");
    sqlx::query(
        "INSERT INTO dataset_shares (id, dataset_id, principal_type, principal_id, role) \
         VALUES (randomblob(16), $1, 'group', $2, 'view')",
    )
    .bind(fx.d_bob)
    .bind(group)
    .execute(&fx.pool)
    .await
    .expect("group-share the dataset");

    // `f_bob` is linked to `d_bob`, so the DATASET branch is the only one that can
    // admit anyone here — the loose-file branch cannot fire for a linked file.
    let principals = [
        ("bob (uploader, member)", fx.bob),
        ("dana (co-member)", fx.dana),
        ("active-group sharee", grouped),
        ("stranger", stranger),
    ];

    let mut verdicts = Vec::new();
    for phase in ["before removal", "after removal", "after group disabled"] {
        if phase == "after removal" {
            fx.remove_bob().await;
        }
        if phase == "after group disabled" {
            let done = sqlx::query("UPDATE groups SET is_active = false WHERE id = $1")
                .bind(group)
                .execute(&fx.pool)
                .await
                .expect("disable the group");
            assert_eq!(
                done.rows_affected(),
                1,
                "the fixture must actually have disabled the group — otherwise this \
                 phase silently repeats the previous one"
            );
        }
        for (pname, principal) in principals {
            let file_ok = !readable_file_ids(&fx.pool, principal, &[fx.f_bob])
                .await
                .unwrap()
                .is_empty();
            let dataset_ok = require_dataset_read(&fx.pool, fx.d_bob, principal)
                .await
                .is_ok();
            assert_eq!(
                file_ok, dataset_ok,
                "{phase}: the file predicate and the dataset gate disagree for \
                 {pname} — these two spellings of the same union must not drift"
            );
            verdicts.push(file_ok);
        }
    }

    // NON-VACUITY, asserted where it actually bites. "The matrix contains both
    // verdicts" is NOT enough: dana is admitted in all three phases and the
    // stranger is refused in all three, so six of the twelve entries are constant
    // repeats and that check alone would pass even if `remove_bob()` and the
    // group-disable had had ZERO effect. The informative entries are the two
    // FLIPS, so those are what get asserted. ("entries", not the obvious word —
    // see the naming note in `the_seam_and_file_readable_by_never_disagree`.)
    let idx = |phase: usize, principal: usize| verdicts[phase * principals.len() + principal];
    // principals order: 0 bob, 1 dana, 2 active-group sharee, 3 stranger
    assert!(idx(0, 0) && !idx(1, 0) && !idx(2, 0),
        "bob must FLIP admit → refuse at the removal and stay refused: {:?}",
        (idx(0, 0), idx(1, 0), idx(2, 0)));
    assert!(idx(0, 2) && idx(1, 2) && !idx(2, 2),
        "the group sharee must stay admitted across the removal and FLIP to refused \
         only when the group is disabled: {:?}",
        (idx(0, 2), idx(1, 2), idx(2, 2)));
    assert!(idx(0, 1) && idx(1, 1) && idx(2, 1),
        "positive control: the co-member is admitted throughout");
    assert!(!idx(0, 3) && !idx(1, 3) && !idx(2, 3),
        "negative control: the stranger is refused throughout");
}

/// TEST-19 [acceptance] [invariant: INV-5] — **the SDK store cannot reach a
/// cytoanalyst concept, as a matter of what it is able to compile.**
///
/// The design's hard line is that `ziee-file` "has no concept of cytoanalyst's
/// datasets, accounts, projects or shares, and it must not gain one".
///
/// An earlier version of this test asserted that the crate's sources contain no
/// host vocabulary. That was the wrong shape and it was rightly flagged: a needle
/// list pattern-matches a SEMANTIC property, so its evasion space is unbounded —
/// every round finds another spelling, and passing it proves only that nobody used
/// the words I happened to think of. It is replaced here by the fact it was
/// standing in for.
///
/// `ziee-file` verifies every `sqlx::query!` at COMPILE TIME against a build
/// database built from its own `migrations/` directory and nothing else (see the
/// crate's `build.rs`). So the set of tables that directory defines IS the crate's
/// entire data universe: a query joining `datasets`, `dataset_files` or
/// `account_members` does not merely look wrong, it **cannot compile**. Pinning
/// that set therefore pins the invariant itself, and cannot be evaded by choosing
/// different words — the only way to add a host concept is to add the table here,
/// which fails this test.
#[test]
fn the_sdk_file_crate_cannot_compile_a_query_against_a_host_table() {
    let crate_root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../sdk/crates/ziee-file");
    let migrations = std::path::Path::new(crate_root).join("migrations");

    let mut defined: Vec<String> = Vec::new();
    let mut files_read = 0usize;
    for entry in std::fs::read_dir(&migrations)
        .unwrap_or_else(|e| panic!("read {}: {e}", migrations.display()))
    {
        let path = entry.expect("dir entry").path();
        if path.extension().map(|e| e != "sql").unwrap_or(true) {
            continue;
        }
        files_read += 1;
        let sql = std::fs::read_to_string(&path).expect("read migration");
        for line in sql.lines() {
            let lower = line.to_lowercase();
            if let Some(rest) = lower.split("create table").nth(1) {
                let name = rest
                    .replace("if not exists", "")
                    .trim()
                    .trim_start_matches("public.")
                    .split(|c: char| c == '(' || c.is_whitespace())
                    .next()
                    .unwrap_or("")
                    .to_string();
                if !name.is_empty() {
                    defined.push(name);
                }
            }
        }
    }
    defined.sort();
    defined.dedup();

    // Control: if the walk read nothing, an "empty = clean" result would be a lie.
    assert!(
        files_read > 0 && !defined.is_empty(),
        "the migration set must actually have been read (files={files_read}, \
         tables={defined:?})"
    );

    assert_eq!(
        defined,
        vec!["file_versions".to_string(), "files".to_string()],
        "the crate's compile-time schema universe must be the blob store's own two \
         tables and nothing else. Anything added here is a table `ziee-file` can \
         then JOIN — which is precisely how it would gain a host concept."
    );

    // The other half of "cannot reach the host": no dependency on it.
    let manifest = std::fs::read_to_string(std::path::Path::new(crate_root).join("Cargo.toml"))
        .expect("read ziee-file Cargo.toml");
    assert!(
        !manifest.contains("cytoanalyst"),
        "ziee-file must not depend on the host application"
    );
}

/// TEST-8 / TEST-10 — the SDK's shipped policy defaults, pinned from the repo
/// that owns the pin.
///
/// `DenyAllFileAccess` and `OwnerOnlyFileAccess` are the two impls `ziee-file`
/// ships, and the whole fail-closed argument rests on what they do: the first is
/// what a host reaches for when it has not modelled file authorization yet, the
/// second is the explicit, greppable opt-in back to "ownership is the whole
/// answer". Their behaviour is asserted inside the crate's own suite too — but
/// that suite lives in a submodule this repo's gate cannot see, and an SDK bump
/// could silently change either one. This is the app-side pin: if a future bump
/// made `DenyAllFileAccess` permissive, THIS repo fails.
#[tokio::test]
async fn the_sdk_ships_a_denying_default_and_a_named_permissive_opt_in() {
    use ziee_file::seams::{DenyAllFileAccess, FileAccess, FileAccessPolicy, OwnerOnlyFileAccess};

    let principal = Uuid::new_v4();
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    let candidates = vec![a, b];

    let deny = DenyAllFileAccess;
    for access in [
        FileAccess::ReadMetadata,
        FileAccess::ReadContent,
        FileAccess::Write,
        FileAccess::Delete,
    ] {
        assert!(
            !deny.can_access(principal, a, access).await.unwrap(),
            "DenyAllFileAccess must refuse {access:?} — it is the safe default a \
             host reaches for before it has modelled authorization"
        );
    }
    assert!(
        deny.filter(principal, &candidates, FileAccess::ReadMetadata)
            .await
            .unwrap()
            .is_empty(),
        "and it must enumerate nothing"
    );

    // The permissive opt-in is the CONTRAST that makes the above mean something:
    // both are asked identically and answer oppositely, so a broken harness cannot
    // produce this pair.
    let owner_only = OwnerOnlyFileAccess;
    assert!(
        owner_only
            .can_access(principal, a, FileAccess::ReadContent)
            .await
            .unwrap(),
        "OwnerOnlyFileAccess admits — it reproduces the pre-seam behaviour"
    );
    assert_eq!(
        owner_only
            .filter(principal, &candidates, FileAccess::ReadMetadata)
            .await
            .unwrap(),
        candidates,
        "and passes the candidate set through unchanged, in order"
    );
}

/// TEST-20 [acceptance] [invariant: INV-7] — **a view grant must never destroy
/// data.**
///
/// Before the read/write split, every `FileAccess` kind resolved through the READ
/// predicate. That closed the removed-member hole but left a `view`-role sharee
/// able to DELETE files they had uploaded into someone else's dataset — a read
/// grant that destroys data.
///
/// The deny is paired with the two controls that make it mean something: the SAME
/// principal, same file, same route, admitted for READ (so the refusal is the write
/// gate's and not a lost fixture), and an `edit`-role sharee who CAN delete (so the
/// route is reachable and DELETE genuinely works).
#[tokio::test]
async fn a_view_only_sharee_can_read_but_cannot_delete_or_restore() {
    let server = TestServer::spawn().await;
    let fx = Fx::build(&server).await;

    // Two sharees on bob's org dataset: one `view`, one `edit`. Each uploads their
    // OWN file into it, because the store's `files.user_id` conjunct still applies —
    // only the uploader reaches these routes at all, so the sharee under test must
    // be the uploader for the WRITE gate to be the thing that decides.
    let (viewer, viewer_tok) = user_with_token(&server, &fx.admin, "viewer").await;
    let (editor, editor_tok) = user_with_token(&server, &fx.admin, "editor").await;

    for (principal, role) in [(viewer, "view"), (editor, "edit")] {
        sqlx::query(
            "INSERT INTO dataset_shares (id, dataset_id, principal_type, principal_id, role) \
             VALUES (randomblob(16), $1, 'user', $2, $3)",
        )
        .bind(fx.d_bob)
        .bind(principal)
        .bind(role)
        .execute(&fx.pool)
        .await
        .unwrap_or_else(|e| panic!("share {role}: {e}"));
    }

    // Each sharee uploads a file, which is then linked into the SHARED dataset — so
    // their standing over it comes from the share and nothing else.
    let mut file_of = std::collections::HashMap::new();
    for (name, tok) in [("viewer", &viewer_tok), ("editor", &editor_tok)] {
        let (_ds, f) = dataset_with_uploaded_file(
            &server,
            tok,
            &format!("{name}s-scratch"),
            &format!("{name}.csv"),
            DANA_BYTES,
        )
        .await;
        sqlx::query("UPDATE dataset_files SET dataset_id = $1 WHERE file_id = $2")
            .bind(fx.d_bob)
            .bind(f)
            .execute(&fx.pool)
            .await
            .expect("relink into the shared dataset");
        file_of.insert(name, f);
    }
    let viewer_file = file_of["viewer"];
    let editor_file = file_of["editor"];

    // CONTROL 1 — the view sharee genuinely HAS read standing on their file.
    let (status, body) = fx
        .get(&server, &viewer_tok, &format!("/files/{viewer_file}/download"))
        .await;
    assert_eq!(
        status, 200,
        "control: a view-role sharee reads the file they uploaded into the shared \
         dataset — so the DELETE refusal below is the write gate, not a missing file"
    );
    assert_eq!(body, DANA_BYTES, "control: and gets the real bytes");

    // THE INVARIANT — read standing does not carry destruction.
    let resp = server
        .client
        .delete(server.api_url(&format!("/files/{viewer_file}")))
        .bearer_auth(&viewer_tok)
        .send()
        .await
        .expect("viewer delete");
    assert_eq!(
        resp.status().as_u16(),
        404,
        "a VIEW-only sharee must not DELETE — a view grant must never destroy data"
    );
    let alive: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM files WHERE id = $1)")
        .bind(viewer_file)
        .fetch_one(&fx.pool)
        .await
        .expect("existence probe");
    assert!(alive, "and the row must SURVIVE the refused DELETE");

    let resp = server
        .client
        .post(server.api_url(&format!("/files/{viewer_file}/restore")))
        .bearer_auth(&viewer_tok)
        .json(&json!({ "version": 1 }))
        .send()
        .await
        .expect("viewer restore");
    assert_eq!(
        resp.status().as_u16(),
        404,
        "nor may they RESTORE — restore moves the head, so it is a write too"
    );

    // CONTROL 2 — an EDIT sharee can. Without this the deny above would pass
    // identically if the write gate simply refused everyone.
    let resp = server
        .client
        .delete(server.api_url(&format!("/files/{editor_file}")))
        .bearer_auth(&editor_tok)
        .send()
        .await
        .expect("editor delete");
    assert_eq!(
        resp.status().as_u16(),
        204,
        "positive control: an EDIT-role sharee still deletes — the gate discriminates \
         by role rather than refusing all shares"
    );
    let _ = editor;
}

/// TEST-21 [acceptance] [invariant: INV-7] — the write branch is the `can_edit`
/// union, not a new spelling of it.
///
/// `writable_file_ids`' dataset branch is a third hand-copy of the disjunction in
/// `DatasetRepository::access`'s `can_edit!` arm (the second being `editable_subset`,
/// which is already pinned to its original by `editable_subset_matches_access`).
/// Hand-copies of this exact union have drifted before, so this holds the new one to
/// the same standard: for a dataset-linked file, "may write the file" must equal
/// "may edit its dataset", across a role matrix containing BOTH verdicts.
#[tokio::test]
async fn the_write_branch_agrees_with_require_can_edit() {
    use cytoanalyst::modules::dataset::repository::{DatasetAccess, DatasetRepository};
    use cytoanalyst::modules::file::access::writable_file_ids;

    let server = TestServer::spawn().await;
    let fx = Fx::build(&server).await;
    let datasets = DatasetRepository::new(fx.pool.clone());

    let (viewer, _vt) = user_with_token(&server, &fx.admin, "w_viewer").await;
    let (editor, _et) = user_with_token(&server, &fx.admin, "w_editor").await;
    let (nobody, _nt) = user_with_token(&server, &fx.admin, "w_nobody").await;
    for (principal, role) in [(viewer, "view"), (editor, "edit")] {
        sqlx::query(
            "INSERT INTO dataset_shares (id, dataset_id, principal_type, principal_id, role) \
             VALUES (randomblob(16), $1, 'user', $2, $3)",
        )
        .bind(fx.d_bob)
        .bind(principal)
        .bind(role)
        .execute(&fx.pool)
        .await
        .expect("seed share");
    }

    // Every principal is made the file's uploader in turn, so the store's owner
    // conjunct (which lives in the SDK, not in this predicate) cannot mask a
    // disagreement between the two spellings.
    let principals = [
        ("bob (creator, member)", fx.bob),
        ("dana (bare co-member)", fx.dana),
        ("view sharee", viewer),
        ("edit sharee", editor),
        ("unrelated", nobody),
    ];

    let mut verdicts = Vec::new();
    for (pname, principal) in principals {
        sqlx::query("UPDATE files SET user_id = $1 WHERE id = $2")
            .bind(principal)
            .bind(fx.f_bob)
            .execute(&fx.pool)
            .await
            .expect("re-point the uploader");

        let via_file = !writable_file_ids(&fx.pool, principal, &[fx.f_bob])
            .await
            .unwrap()
            .is_empty();
        let via_dataset = matches!(
            datasets.access(fx.d_bob, principal, &[]).await.unwrap(),
            DatasetAccess::CanEdit
        );
        assert_eq!(
            via_file, via_dataset,
            "{pname}: the file WRITE predicate and DatasetRepository::access's \
             can_edit arm disagree — a third hand-copy of this union has drifted"
        );

        // And write standing must never exceed read standing.
        let readable = !readable_file_ids_pub(&fx.pool, principal, &[fx.f_bob])
            .await
            .unwrap()
            .is_empty();
        assert!(
            !via_file || readable,
            "{pname}: writable but NOT readable — write standing must be a strict \
             subset of read standing"
        );

        verdicts.push(via_file);
    }

    assert!(
        verdicts.iter().any(|v| *v) && verdicts.iter().any(|v| !*v),
        "the role matrix must contain BOTH admits and denies: {verdicts:?}"
    );
}

/// Re-export shim so the subset assertion above reads clearly.
async fn readable_file_ids_pub(
    pool: &sqlx::SqlitePool,
    user: Uuid,
    ids: &[Uuid],
) -> Result<Vec<Uuid>, ziee_core::AppError> {
    cytoanalyst::modules::file::access::readable_file_ids(pool, user, ids).await
}
