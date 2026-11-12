//! **TEST-5 [acceptance] [invariant: INV-4] [covers: ITEM-4, ITEM-9]** and
//! **TEST-10 [covers: ITEM-4]**.
//!
//! > *artifact — immutable, content-addressed. **One row, one file or one
//! > directory.** Members of a directory are addressed by path through a merkle
//! > manifest.*
//! > — `00_CONSOLIDATED_DESIGN.md` §0.3, "Concepts".
//!
//! Two claims, and the second is the one that is easy to lose:
//!
//!   * **a member is addressed by PATH, through the merkle manifest** — not by an
//!     index, not by a filesystem walk, not by a per-member row;
//!   * **addressing one changes nothing** — the composite `content_hash` after any
//!     number of member reads is the value it had before. A directory is ONE
//!     immutable artifact; reading part of it is not an event in its life.
//!
//! ## What makes this more than "a GET returned a member"
//!
//! A resolver that ignored paths entirely and returned the first member would pass a
//! single-member test, and a resolver keyed on ordinal position would pass a test
//! whose members happen to be requested in order. So the fixture is built to
//! discriminate:
//!
//!  * **two members hold IDENTICAL bytes at different paths.** They dedup to one
//!    blob in a content-addressed store, so a manifest that lost a path — or a
//!    resolver that keyed on the blob — would drop one of them.
//!  * **resolution is EXACT-MATCH.** A prefix, a suffix and a case variant of a real
//!    member path are all `404`, which an ordinal or fuzzy resolver could not
//!    produce.
//!  * **identity is a function of the (path, bytes) SET.** Re-ingesting the same
//!    directory yields the same `content_hash`; changing one member's BYTES changes
//!    it; and — the assertion that proves the manifest binds PATHS and not just a bag
//!    of blobs — **moving one member to a different path, with every byte identical,
//!    changes it too.**
//!
//! **TEST-10** rides the same fixture: *n* arrays sharing an axis arrive as MEMBERS
//! of one artifact with one merkle identity, not as *n* artifacts. That is the
//! difference between a composite that can drift and one that cannot.

use serde_json::{json, Value};
use sqlx::SqlitePool;
use uuid::Uuid;

use txresbench::modules::workstore::catalog::models::Artifact;
use txresbench::modules::workstore::catalog::repository::CatalogRepository;
use txresbench::modules::workstore::ingest::ingest_run_outputs;
use txresbench::modules::workstore::object_store::LocalFsStore;

use super::{create_project, pool_for, server_store, setup_admin, write_manifest};
use crate::common::TestServer;

/// A composite: three arrays over one shared axis, each a Zarr array directory, plus
/// the store-level metadata document. Seven members, four directory levels, and —
/// deliberately — `pval/c/0` and `padj/c/0` hold the SAME bytes.
///
/// The duplicate is the point: a content-addressed store keeps ONE blob for them, so
/// the two paths survive only if the manifest really maps path → blob rather than
/// the other way round.
fn composite_members() -> Vec<(String, Vec<u8>)> {
    let shared: Vec<u8> = vec![0x11, 0x22, 0x33, 0x44];
    vec![
        (
            "zarr.json".to_string(),
            br#"{"zarr_format":3,"node_type":"group"}"#.to_vec(),
        ),
        (
            "logFC/zarr.json".to_string(),
            br#"{"zarr_format":3,"node_type":"array","shape":[4]}"#.to_vec(),
        ),
        ("logFC/c/0".to_string(), vec![0xa0, 0xa1, 0xa2, 0xa3]),
        ("logFC/c/3".to_string(), vec![0xd0, 0xd1, 0xd2, 0xd3]),
        (
            "pval/zarr.json".to_string(),
            br#"{"zarr_format":3,"node_type":"array","shape":[4]}"#.to_vec(),
        ),
        ("pval/c/0".to_string(), shared.clone()),
        ("padj/c/0".to_string(), shared),
    ]
}

/// The producer's declaration for the composite: three 1-D members over one shared axis.
/// The server stores it verbatim; the CLIENT expands the member list (§0.3, "API").
///
/// ── THE VOCABULARY IS THE REAL ONE, NOT A PLAUSIBLE-LOOKING ONE ─────────────────
/// This used to declare `"kind": "composite"`, which NO producer emits and which
/// `ui/src/core/workstore/artifactReader.ts` explicitly REJECTS (`KNOWN_ZARR_KINDS` is
/// `table` | `sparse_csc`, and an unrecognised kind throws rather than being guessed at).
/// A fixture speaking a vocabulary nothing in the system speaks is how a test stops being
/// evidence about the system: it can keep passing while the shape it asserts on has
/// become unreadable everywhere else. The kind, the `columns`/`arrays` split (`txr_zarr`
/// `Table._record` files a 1-D member under `columns` and a ≥2-D one under `arrays`) and
/// the per-member `path`/`shape` keys below are all the shapes `txr_zarr.Table.close()`
/// actually writes.
fn composite_structure() -> Value {
    json!({
        "encoding": "zarr_v3",
        "kind": "table",
        "axis": "rows",
        "n": 4,
        "columns": [
            { "name": "logFC", "path": "logFC", "kind": "numeric", "dtype": "float32",
              "axis": "rows", "shape": [4] },
            { "name": "pval",  "path": "pval",  "kind": "numeric", "dtype": "float32",
              "axis": "rows", "shape": [4] },
            { "name": "padj",  "path": "padj",  "kind": "numeric", "dtype": "float32",
              "axis": "rows", "shape": [4] }
        ],
        "arrays": []
    })
}

/// Ingest `members` as ONE directory artifact and return its row.
async fn ingest_dir(
    server: &TestServer,
    pool: &SqlitePool,
    store: &LocalFsStore,
    project: Uuid,
    output_id: &str,
    members: &[(String, Vec<u8>)],
) -> Artifact {
    let ws = server
        .data_dir()
        .join(format!("staging-{}", Uuid::new_v4()));
    let manifest = json!({ "outputs": [
        { "id": output_id, "datatype": "data/opaque", "path": "result", "layout": "opaque",
          "role": "artifact",
          "structure": composite_structure(), "meta": { "title": "a composite result" } }
    ]});
    let owned: Vec<(String, Vec<u8>)> = members
        .iter()
        .map(|(p, b)| (format!("result/{p}"), b.clone()))
        .collect();
    let refs: Vec<(&str, &[u8])> = owned
        .iter()
        .map(|(p, b)| (p.as_str(), b.as_slice()))
        .collect();
    write_manifest(&ws, &manifest, &refs).await;
    let mut rows = ingest_run_outputs(pool, store, Some(project), None, Uuid::new_v4(), None, &ws)
        .await
        .expect("ingest the directory");
    assert_eq!(rows.len(), 1, "a directory is ONE artifact row (INV-4)");
    rows.remove(0)
}

// ── TEST-5 + TEST-10 ──────────────────────────────────────────────────────────

#[tokio::test]
async fn test5_members_resolve_by_path_and_reading_them_changes_no_identity() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let sid = create_project(&server, &token, "member-path").await;
    let pool = pool_for(&server).await;
    let store = server_store(&server);

    let members = composite_members();
    let art = ingest_dir(&server, &pool, &store, sid, "result", &members).await;

    // ── TEST-10 — n arrays sharing an axis are MEMBERS of one artifact ────────
    // Not three artifacts that must be kept in step by convention: one row, one
    // merkle identity, so the three arrays cannot drift apart.
    let rows_in_project: i64 =
        sqlx::query_scalar("SELECT count(*) FROM artifacts WHERE project_id = $1")
            .bind(sid)
            .fetch_one(&pool)
            .await
            .expect("count");
    assert_eq!(
        rows_in_project, 1,
        "three arrays over one axis produced {rows_in_project} catalog rows; the \
         design says one row, one directory"
    );
    assert!(
        art.is_multifile,
        "the row is a directory, addressed by member"
    );
    // `columns` is where a 1-D member over the shared axis is declared (the `arrays` slot
    // is for ≥2-D members) — see `composite_structure`. The claim is unchanged: all three
    // are declared on the ONE row, for the client to expand.
    assert_eq!(
        art.structure["columns"]
            .as_array()
            .expect("declared columns")
            .len(),
        3,
        "the three arrays are DECLARED on the single row, for the client to expand"
    );
    assert_eq!(
        art.stored_bytes,
        members.iter().map(|(_, b)| b.len() as i64).sum::<i64>(),
        "the one row accounts for every member's bytes"
    );

    // ── a member resolves BY PATH ─────────────────────────────────────────────
    let get = |member: &str| {
        let url = server.api_url(&format!("/artifacts/{}/data/{member}", art.id));
        let client = server.client.clone();
        let token = token.clone();
        async move {
            client
                .get(url)
                .bearer_auth(token)
                .send()
                .await
                .expect("member request")
        }
    };

    for (path, bytes) in &members {
        let r = get(path).await;
        assert_eq!(
            r.status().as_u16(),
            200,
            "member `{path}` did not resolve through the manifest"
        );
        assert_eq!(
            r.headers()
                .get("content-length")
                .and_then(|v| v.to_str().ok()),
            Some(bytes.len().to_string().as_str()),
            "member `{path}` reported the wrong length"
        );
        assert_eq!(
            r.bytes().await.expect("body").as_ref(),
            bytes.as_slice(),
            "member `{path}` served the wrong bytes — resolution is not keyed on the \
             path it was asked for"
        );
    }

    // The two paths holding IDENTICAL bytes both resolve, to those bytes. A
    // content-addressed store keeps one blob for them; if the manifest were keyed
    // blob-first, or if a de-duplicating write dropped a path, one of these is a 404.
    let (a, b) = (get("pval/c/0").await, get("padj/c/0").await);
    assert_eq!(a.status().as_u16(), 200);
    assert_eq!(b.status().as_u16(), 200);
    assert_eq!(
        a.bytes().await.expect("body"),
        b.bytes().await.expect("body"),
        "two paths onto one deduplicated blob must both serve it"
    );

    // …and a nested member of a nested array, the design's own example.
    assert_eq!(
        get("logFC/c/3").await.bytes().await.expect("body").as_ref(),
        [0xd0, 0xd1, 0xd2, 0xd3].as_slice(),
        "`/data/logFC/c/3` is the design's worked example of a member path"
    );

    // A byte RANGE within a member is still that member's bytes — the span is
    // resolved after the path, not instead of it.
    let r = server
        .client
        .get(server.api_url(&format!("/artifacts/{}/data/logFC/c/3?range=1-2", art.id)))
        .bearer_auth(&token)
        .send()
        .await
        .expect("ranged member request");
    assert_eq!(r.status().as_u16(), 200);
    assert_eq!(
        r.bytes().await.expect("body").as_ref(),
        [0xd1, 0xd2].as_slice()
    );

    // ── resolution is an EXACT map lookup, not a path walk or a prefix match ──
    // An ordinal resolver, a prefix resolver or a filesystem walk each answers at
    // least one of these with bytes.
    for absent in [
        "logFC",            // a directory prefix is not a member
        "logFC/c",          // …nor an interior one
        "logFC/c/3x",       // a suffix
        "logFC/c/",         // a trailing separator
        "LOGFC/c/3",        // case matters: the manifest key is a byte string
        "zarr.jso",         // a prefix of a real member
        "c/0",              // a member path that exists only INSIDE an array dir
        "result/logFC/c/3", // the staging-relative path, not the member path
    ] {
        assert_eq!(
            get(absent).await.status().as_u16(),
            404,
            "`{absent}` is not a key in the merkle manifest and must not resolve — \
             members are addressed by exact path, through the manifest"
        );
    }

    // A directory has no single-blob body: the member path is not optional.
    let whole = server
        .client
        .get(server.api_url(&format!("/artifacts/{}/data", art.id)))
        .bearer_auth(&token)
        .send()
        .await
        .expect("whole-object request");
    assert_eq!(
        whole.status().as_u16(),
        400,
        "a multi-file artifact has no whole-object body; its members are addressed by \
         path"
    );

    // ── ADDRESSING A MEMBER LEAVES THE COMPOSITE IDENTITY UNTOUCHED ───────────
    // Every read above (whole members, a range, eight 404s, one 400) has happened.
    // The row must be exactly what ingest wrote.
    let repo = CatalogRepository::new(pool.clone());
    let after = repo
        .get_any_status(art.id)
        .await
        .expect("get")
        .expect("the row is still there");
    assert_eq!(
        after.content_hash, art.content_hash,
        "the composite `content_hash` moved after its members were addressed. An \
         artifact is immutable and content-addressed: reading part of it is not an \
         event in its life, and a hash that shifts on access is not an identity"
    );
    assert_eq!(after.object_key, art.object_key, "the manifest blob moved");
    assert_eq!(after.is_multifile, art.is_multifile);
    assert_eq!(after.stored_bytes, art.stored_bytes);
    assert_eq!(
        after.updated_at, art.updated_at,
        "reading a member touched the row's `updated_at` — a read wrote"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM artifacts WHERE project_id = $1")
            .bind(sid)
            .fetch_one(&pool)
            .await
            .expect("count"),
        1,
        "addressing members minted extra rows"
    );
}

// ── the merkle identity is a function of the (path, bytes) SET ────────────────

#[tokio::test]
async fn test5_the_composite_identity_covers_every_member_path_and_byte() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let sid = create_project(&server, &token, "merkle-identity").await;
    let pool = pool_for(&server).await;
    let store = server_store(&server);

    let base = composite_members();
    let original = ingest_dir(&server, &pool, &store, sid, "original", &base).await;

    // (a) The SAME directory, ingested again as a different output of a different
    //     run: the same identity. Identity is content, not provenance.
    let again = ingest_dir(&server, &pool, &store, sid, "again", &base).await;
    assert_eq!(
        again.content_hash, original.content_hash,
        "the same member set produced two identities — the composite hash is being \
         fed something other than its members"
    );
    assert_eq!(again.object_key, original.object_key);

    // (b) One member's BYTES changed → a different identity.
    let mut changed_bytes = base.clone();
    changed_bytes
        .iter_mut()
        .find(|(p, _)| p == "logFC/c/3")
        .expect("the member to perturb")
        .1 = vec![0xd0, 0xd1, 0xd2, 0xd4]; // one byte
    let perturbed = ingest_dir(&server, &pool, &store, sid, "one_byte", &changed_bytes).await;
    assert_ne!(
        perturbed.content_hash, original.content_hash,
        "changing one byte of one member left the composite identity unchanged — the \
         merkle root does not cover its members"
    );

    // (c) One member MOVED — every byte in the artifact identical, one path
    //     different → a different identity.
    //
    //     This is the assertion that proves the manifest binds PATHS. A merkle root
    //     over the bag of blobs alone passes (a) and (b) and fails here, and a
    //     composite whose members could be re-arranged without changing its identity
    //     is one whose parts can silently swap places.
    let mut moved = base.clone();
    moved
        .iter_mut()
        .find(|(p, _)| p == "logFC/c/3")
        .expect("the member to move")
        .0 = "logFC/c/7".to_string();
    assert_eq!(
        {
            let mut a: Vec<&Vec<u8>> = base.iter().map(|(_, b)| b).collect();
            let mut b: Vec<&Vec<u8>> = moved.iter().map(|(_, b)| b).collect();
            a.sort();
            b.sort();
            a == b
        },
        true,
        "the moved fixture must hold exactly the same BYTES as the original, or (c) \
         is just a restatement of (b)"
    );
    let relocated = ingest_dir(&server, &pool, &store, sid, "moved", &moved).await;
    assert_ne!(
        relocated.content_hash, original.content_hash,
        "moving a member to a different path, with every byte unchanged, left the \
         composite identity unchanged — the merkle manifest is not binding paths, so \
         two different directories share one content identity"
    );

    // …and the moved member is addressable at its NEW path and gone from the old.
    let get = |id: Uuid, member: &str| {
        let url = server.api_url(&format!("/artifacts/{id}/data/{member}"));
        let client = server.client.clone();
        let token = token.clone();
        async move {
            client
                .get(url)
                .bearer_auth(token)
                .send()
                .await
                .expect("member request")
        }
    };
    assert_eq!(get(relocated.id, "logFC/c/7").await.status().as_u16(), 200);
    assert_eq!(get(relocated.id, "logFC/c/3").await.status().as_u16(), 404);
    // …while the ORIGINAL artifact still serves it at the old path. Two rows, two
    // manifests, one shared blob — and neither can perturb the other.
    assert_eq!(get(original.id, "logFC/c/3").await.status().as_u16(), 200);
    assert_eq!(get(original.id, "logFC/c/7").await.status().as_u16(), 404);
}
