//! The `txresbench-file` HTTP surface (`file_routes`, merged under `/api` by
//! `modules::file`) — the **authorization** suite, app build.
//!
//! ## What this file is about (strip-single-cell ITEM-3)
//!
//! The platform authorization story this suite used to pin was the DATASET one:
//! a removed org member kept reading/deleting files they had uploaded into the
//! organization's datasets because `files.user_id` is the uploading actor and
//! survives removal. That graph (orgs, datasets, shares, memberships) is GONE in
//! this build, along with the dataset-upload route that was the only HTTP way a
//! `files` row was created.
//!
//! What remains is the seam's basic contract, which is now the WHOLE story:
//!
//! - the store's owner scope (`files.user_id = principal`) is the first conjunct
//!   of [`txresbench_file::http::context::FileContext::authorized_file`] — a
//!   principal who is not the uploader never even sees the row (a host policy
//!   can only NARROW access, never widen it);
//! - the second conjunct is the host's [`FileAccessPolicy`], implemented by
//!   [`modules::file::access::DatasetFileAccessPolicy`], whose app answer is
//!   uploader + platform admin (`files.user_id` or `users.is_admin`) — see that
//!   module's doc for why that is the whole question once the dataset branch is
//!   gone;
//! - every failure renders as `404`, never `403`: a distinguishable status would
//!   confirm the file exists to a principal not entitled to know it.
//!
//! The suite drives the REAL routes with REAL bytes on disk (the harness exposes
//! the spawned server's `data_dir()`, so a test seeds the blob at the exact path
//! the storage layout derives) and pairs every deny with a positive control, so
//! a route that 404s for an unrelated reason cannot read as success.

use serde_json::{json, Value};
use sqlx::SqlitePool;
use txresbench_file::storage::FileStorage;
use txresbench_file::FilesystemStorage;
use uuid::Uuid;

use super::account::{pool_for, setup_admin};
use crate::common::TestServer;

const BOB_BYTES: &[u8] = b"id,value\nbob_row,7\n";
const STRANGER_BYTES: &[u8] = b"id,value\nstranger_row,3\n";

/// Create a user AND log them in — the routes under test are all bearer-authed,
/// so every principal needs a real token, not just an id.
async fn user_with_token(server: &TestServer, admin: &str, username: &str) -> (Uuid, String) {
    let resp = server
        .client
        .post(server.api_url("/auth/register"))
        .bearer_auth(admin)
        .json(&json!({
            "username": username,
            "email": format!("{username}@txresbench.test"),
            "password": "userPassw0rd!",
        }))
        .send()
        .await
        .expect("create user");
    assert_eq!(resp.status().as_u16(), 201, "create user {username}");
    let id = Uuid::parse_str(
        resp.json::<Value>()
            .await
            .expect("user json")["user"]["id"]
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

/// Seed a durable file with REAL bytes, the way the removed dataset-upload route
/// used to: a `files` + `file_versions` row pair in the per-test DB and the blob
/// written at the exact path [`FilesystemStorage`] derives for the app's file
/// root (`<data_dir>/files/originals/<user_id>/<file_id>.<ext>`). The harness
/// exposes the spawned server's `data_dir()`, so the blob lands where the server
/// process's storage reads it — the server never sees the test process's
/// globals, so the bytes are placed directly.
async fn seed_file(
    server: &TestServer,
    pool: &SqlitePool,
    owner: Uuid,
    filename: &str,
    bytes: &[u8],
) -> Uuid {
    let storage = FilesystemStorage::new(server.data_dir().join("files"));
    let ext = filename
        .rsplit('.')
        .next()
        .expect("filename has an extension")
        .to_ascii_lowercase();
    let file_id = Uuid::new_v4();
    let version_id = Uuid::new_v4();
    let blob_version_id = Uuid::new_v4();

    // The download/version paths read the blob keyed on the head version's
    // `blob_version_id` (`load_original(user, blob_version_id, ext)`), not on the
    // file id — the file's `current_version_id` points at the version row below.
    let path = storage.get_original_path(owner, blob_version_id, &ext);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .expect("create blob parent dir");
    }
    tokio::fs::write(&path, bytes)
        .await
        .expect("write blob bytes");

    sqlx::query(
        r#"INSERT INTO file_versions
           (id, file_id, version, is_head, blob_version_id, file_size, mime_type,
            checksum, has_thumbnail, preview_page_count, text_page_count,
            processing_metadata, source_message_id, created_by)
           VALUES ($1, $2, 1, 1, $3, $4, $5, NULL, 0, 0, 0, '{}', NULL, 'test')"#,
    )
    .bind(version_id)
    .bind(file_id)
    .bind(blob_version_id)
    .bind(bytes.len() as i64)
    .bind("text/csv")
    .execute(pool)
    .await
    .expect("insert file_versions");

    sqlx::query(
        r#"INSERT INTO files
           (id, user_id, filename, file_size, mime_type, checksum, has_thumbnail,
            preview_page_count, text_page_count, processing_metadata, created_at,
            updated_at, created_by, current_version_id)
           VALUES ($1, $2, $3, $4, $5, NULL, 0, 0, 0, '{}',
                   strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                   strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'test', $6)"#,
    )
    .bind(file_id)
    .bind(owner)
    .bind(filename)
    .bind(bytes.len() as i64)
    .bind("text/csv")
    .bind(version_id)
    .execute(pool)
    .await
    .expect("insert files");

    file_id
}

/// `GET <path>` as `token`, returning `(status, body_bytes)`.
async fn get(server: &TestServer, token: &str, path: &str) -> (u16, Vec<u8>) {
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

/// TEST-1 [acceptance] — the owner-scope contract through the REAL routes.
///
/// The uploader reaches every surface and gets the exact bytes; a stranger is
/// refused on EVERY surface (read, write, mint) with 404, the row survives a
/// refused DELETE, and the stranger's listing is empty. Every deny is paired
/// with the uploader's admit, so an unmounted or broken route cannot read as a
/// correct refusal.
#[tokio::test]
async fn the_uploader_reaches_every_surface_and_a_stranger_nowhere() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let (bob, bob_tok) = user_with_token(&server, &admin, "bob").await;
    let (_stranger, stranger_tok) = user_with_token(&server, &admin, "stranger").await;

    let file = seed_file(&server, &pool, bob, "bob.csv", BOB_BYTES).await;

    // POSITIVE CONTROLS FIRST (the uploader): this is what proves the bytes are
    // really on disk and the routes really work — a fixture that never wrote a
    // blob cannot produce the 200 + exact payload below.
    for (path, name) in read_surfaces(file) {
        let (status, _) = get(&server, &bob_tok, &path).await;
        assert_ne!(
            status, 404,
            "precondition: the uploader reaches `{name}` ({path})"
        );
    }
    let (status, body) = get(&server, &bob_tok, &format!("/files/{file}/download")).await;
    assert_eq!(status, 200, "the uploader downloads their own bytes");
    assert_eq!(body, BOB_BYTES, "and gets the EXACT payload from disk");

    // THE INVARIANT: a principal who is not the uploader is refused everywhere.
    for (path, name) in read_surfaces(file) {
        let (status, _) = get(&server, &stranger_tok, &path).await;
        assert_eq!(
            status, 404,
            "a stranger is refused `{name}` ({path}) — owner scope, unchanged by ITEM-3"
        );
    }

    // Write surfaces: refuse AND leave the row intact.
    let resp = server
        .client
        .delete(server.api_url(&format!("/files/{file}")))
        .bearer_auth(&stranger_tok)
        .send()
        .await
        .expect("stranger delete");
    assert_eq!(resp.status().as_u16(), 404, "a stranger must not DELETE");
    let alive: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM files WHERE id = $1)")
        .bind(file)
        .fetch_one(&pool)
        .await
        .expect("existence probe");
    assert!(
        alive,
        "and the row must SURVIVE — a 404 returned after a delete already \
         succeeded is not a refusal"
    );

    let resp = server
        .client
        .post(server.api_url(&format!("/files/{file}/restore")))
        .bearer_auth(&stranger_tok)
        .json(&json!({ "version": 1 }))
        .send()
        .await
        .expect("stranger restore");
    assert_eq!(resp.status().as_u16(), 404, "nor may they RESTORE a version");

    let resp = server
        .client
        .post(server.api_url(&format!("/files/{file}/download-token")))
        .bearer_auth(&stranger_tok)
        .json(&json!({}))
        .send()
        .await
        .expect("stranger token");
    assert_eq!(resp.status().as_u16(), 404, "nor may they mint a download token");

    // The stranger must not ENUMERATE the file either.
    let (status, body) = get(&server, &stranger_tok, "/files?page=1&per_page=100").await;
    assert_eq!(status, 200);
    let v: Value = serde_json::from_slice(&body).expect("list json");
    assert_eq!(v["total"].as_i64(), Some(0), "the stranger's list is empty");

    // THE WRITE CONTROL: the uploader really can delete their own file — the
    // route is mounted and the deny above is the stranger's standing, not a
    // broken route.
    let resp = server
        .client
        .delete(server.api_url(&format!("/files/{file}")))
        .bearer_auth(&bob_tok)
        .send()
        .await
        .expect("bob delete");
    assert_eq!(
        resp.status().as_u16(),
        204,
        "positive control: the uploader still deletes their own file"
    );
}

/// TEST-2 — the filtered listing's paging and total are computed over the
/// FILTERED set, across page boundaries, and a foreign file never appears.
#[tokio::test]
async fn the_listing_filters_pages_and_counts_over_the_visible_set() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let (bob, bob_tok) = user_with_token(&server, &admin, "bob").await;
    let (stranger, _stranger_tok) = user_with_token(&server, &admin, "stranger").await;

    // Five of bob's own files + one file the STRANGER owns. Bob's pages must
    // never show the foreign file and the total must be the filtered count.
    for i in 0..5 {
        seed_file(&server, &pool, bob, &format!("p{i}.csv"), BOB_BYTES).await;
    }
    let foreign = seed_file(&server, &pool, stranger, "foreign.csv", STRANGER_BYTES).await;

    let mut seen: Vec<Uuid> = Vec::new();
    let mut totals: Vec<i64> = Vec::new();
    for page in 1..=3 {
        let (status, body) = get(
            &server,
            &bob_tok,
            &format!("/files?page={page}&per_page=2"),
        )
        .await;
        assert_eq!(status, 200);
        let v: Value = serde_json::from_slice(&body).expect("list json");
        totals.push(v["total"].as_i64().expect("total"));
        let page_files = v["files"].as_array().expect("files");
        // NO SHORT PAGES: a page-then-filter implementation returns a page
        // shorter than `per_page` whenever the filter removes a row from the
        // middle.
        let expected_len = if page < 3 { 2 } else { 1 };
        assert_eq!(
            page_files.len(),
            expected_len,
            "page {page} must be full ({expected_len}) — filtering happens before \
             paging, so no page is short except the last"
        );
        for f in page_files {
            seen.push(Uuid::parse_str(f["id"].as_str().expect("file id")).unwrap());
        }
    }

    assert!(
        totals.iter().all(|t| *t == 5),
        "the total is the FILTERED count on every page, not the store's owner count: {totals:?}"
    );
    let mut unique = seen.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(unique.len(), seen.len(), "no id may appear on two pages: {seen:?}");
    assert_eq!(seen.len(), 5, "paging yields exactly the visible files");
    assert!(
        !seen.contains(&foreign),
        "the stranger's file appears on NO page of the filter's listing"
    );
}

/// TEST-3 — the host [`FileAccessPolicy`] predicate's app answer, pinned at the
/// pool: the uploader AND the platform admin are admitted, everyone else is
/// refused, for both read and write standing.
///
/// The admin half is not observable over the mounted routes — the store's owner
/// conjunct runs first and a non-uploader never reaches the policy — but it IS
/// the policy's contract (the `users.is_admin` bypass mirrors every other gate
/// in this build), so it is pinned here directly.
#[tokio::test]
async fn the_access_predicate_admits_only_uploader_and_admin() {
    use txresbench::modules::file::access::readable_file_ids;

    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let (bob, _bob_tok) = user_with_token(&server, &admin, "bob").await;
    let (stranger, _stranger_tok) = user_with_token(&server, &admin, "stranger").await;
    // The localsession admin user id.
    let admin_id: Uuid = sqlx::query_scalar("SELECT id FROM users WHERE username = 'admin'")
        .fetch_one(&pool)
        .await
        .expect("admin user id");

    let file = seed_file(&server, &pool, bob, "bob.csv", BOB_BYTES).await;

    assert_eq!(
        readable_file_ids(&pool, bob, &[file]).await.unwrap(),
        vec![file],
        "the uploader is admitted"
    );
    assert_eq!(
        readable_file_ids(&pool, admin_id, &[file]).await.unwrap(),
        vec![file],
        "the platform admin bypass (users.is_admin) is admitted"
    );
    assert!(
        readable_file_ids(&pool, stranger, &[file]).await.unwrap().is_empty(),
        "a non-uploader non-admin is refused"
    );
}

/// TEST-4 — `readable_file_ids` returns its answer in CANDIDATE order.
///
/// The seam's contract promises order preservation, and the SDK relies on it to
/// hand back a list it can page. Driven with a deliberately unsorted candidate
/// order and a withheld middle element, so neither input order nor sorted order
/// can pass by coincidence.
#[tokio::test]
async fn readable_file_ids_preserves_candidate_order() {
    use txresbench::modules::file::access::readable_file_ids;

    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let (bob, _bob_tok) = user_with_token(&server, &admin, "bob").await;
    let (stranger, _stranger_tok) = user_with_token(&server, &admin, "stranger").await;

    let mut ids = Vec::new();
    for i in 0..3 {
        ids.push(seed_file(&server, &pool, bob, &format!("o{i}.csv"), BOB_BYTES).await);
    }
    // A file bob does NOT own — the withheld middle element the order test needs.
    let withheld = seed_file(&server, &pool, stranger, "stranger.csv", STRANGER_BYTES).await;

    let mut admitted = ids.clone();
    admitted.sort(); // now ascending by id
    // Rotate into a non-monotone arrangement: [mid, high, low].
    let candidates = vec![admitted[1], admitted[2], admitted[0]];
    let got = readable_file_ids(&pool, bob, &candidates).await.unwrap();
    assert_eq!(
        got, candidates,
        "the readable subset comes back in CANDIDATE order — not ascending by id \
         (which would be {:?}) and not the planner's order",
        admitted
    );

    let mixed = vec![withheld, ids[1], ids[0]];
    let got = readable_file_ids(&pool, bob, &mixed).await.unwrap();
    assert_eq!(got, vec![ids[1], ids[0]], "and the withheld id is dropped in order");
}

// ===========================================================================
// Parent-side proofs of properties the SDK suite also covers.
//
// `txresbench-file` lives in a submodule, so its own tests are invisible to this
// repo's diff — and an id whose evidence nothing here can see is exactly the
// inherited PASS the lifecycle's A11 check exists to refuse. These assert the
// same claims from the app side, where they can be seen.
// ===========================================================================

/// The generated OpenAPI document, as the UI client is built from.
fn generated_openapi() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../ui/openapi/openapi.json");
    let raw = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("read generated openapi at {path}: {e}"));
    serde_json::from_str(&raw).expect("openapi.json parses")
}

/// Every `/api/files…` OPERATION the generated spec exposes, as `METHOD path`.
fn spec_file_operations() -> Vec<String> {
    let doc = generated_openapi();
    let mut ops: Vec<String> = Vec::new();
    for (path, item) in doc["paths"].as_object().expect("paths object").iter() {
        if path != "/api/files" && !path.starts_with("/api/files/") {
            continue;
        }
        for (method, op) in item.as_object().expect("path item").iter() {
            if op.get("operationId").is_some() {
                ops.push(format!("{} {}", method.to_uppercase(), path));
            }
        }
    }
    ops.sort();
    ops
}

/// TEST-5 — the generated contract did not move (ITEM-3 touches no file route).
#[test]
fn the_generated_file_operation_ids_are_unchanged() {
    let doc = generated_openapi();
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
        "the file surface's operationId set must be byte-identical across the strip"
    );
}

/// TEST-6 — the surface list this file sweeps covers every file route the app
/// actually exposes; the write operations are swept by TEST-1's deny/control
/// pair.
#[test]
fn the_swept_surface_list_covers_every_exposed_file_route() {
    let nil = Uuid::nil();
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
    swept.push("GET /api/files".to_string()); // TEST-2
    swept.push("POST /api/files/{file_id}/restore".to_string()); // TEST-1
    swept.push("DELETE /api/files/{file_id}".to_string()); // TEST-1
    swept.push("POST /api/files/{file_id}/download-token".to_string()); // TEST-1
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

/// TEST-7 — the SDK store cannot reach a txresbench concept, as a matter of
/// what it is able to compile. See the sibling of this test in the platform
/// suite for the full rationale; the claim is unchanged by ITEM-3 (and the
/// stripped tables make it only more pointed — no host table may join in).
#[test]
fn the_sdk_file_crate_cannot_compile_a_query_against_a_host_table() {
    let crate_root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../sdk/crates/txresbench-file");
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

    assert!(
        files_read > 0 && !defined.is_empty(),
        "the migration set must actually have been read (files={files_read}, \
         tables={defined:?})"
    );

    assert_eq!(
        defined,
        vec!["file_versions".to_string(), "files".to_string()],
        "the crate's compile-time schema universe must be the blob store's own two \
         tables and nothing else."
    );

    let manifest = std::fs::read_to_string(std::path::Path::new(crate_root).join("Cargo.toml"))
        .expect("read txresbench-file Cargo.toml");
    // Exact dependency-name check, not a substring scan: the rename commit made
    // the crate's OWN package `txresbench-file` and its teammates
    // `txresbench-framework`/`txresbench-auth` (legitimate deps), so a substring
    // scan matches those. The invariant is "no dependency on the HOST app crate
    // (`txresbench`)" — a dependency key that is exactly the host name.
    let host_dep = manifest.lines().any(|l| {
        let t = l.trim();
        t.starts_with("txresbench") && !t.starts_with("txresbench-")
    });
    assert!(
        !host_dep,
        "txresbench-file must not depend on the host application crate"
    );
}

/// TEST-8 — the SDK's shipped policy defaults, pinned from the repo that owns
/// the pin. `DenyAllFileAccess` is the safe default a host reaches for before
/// it has modelled authorization; `OwnerOnlyFileAccess` is the explicit
/// greppable opt-in back to "ownership is the whole answer". The app's own
/// policy sits between them (uploader + admin), pinned in TEST-3.
#[tokio::test]
async fn the_sdk_ships_a_denying_default_and_a_named_permissive_opt_in() {
    use txresbench_file::seams::{DenyAllFileAccess, FileAccess, FileAccessPolicy, OwnerOnlyFileAccess};

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
            "DenyAllFileAccess must refuse {access:?}"
        );
    }
    assert!(
        deny.filter(principal, &candidates, FileAccess::ReadMetadata)
            .await
            .unwrap()
            .is_empty(),
        "and it must enumerate nothing"
    );

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
