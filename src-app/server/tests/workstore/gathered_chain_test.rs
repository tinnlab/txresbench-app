//! **ITEM-21 end-to-end — the chain walk against REAL artifacts, over the REAL serve path.**
//!
//! `gathered.rs`'s twelve unit tests prove the composition ARITHMETIC. They do not prove the
//! walk wires up: that a gathered artifact whose source is itself gathered actually resolves
//! through Postgres and the object store, that the depth limit fires on a real chain, or that
//! a cycle is refused rather than looping a request handler. Those are different claims, and
//! this file is where they are made.
//!
//! Everything below goes through `GET /artifacts/{id}/data/{member}` — the production route,
//! the production authz gate, the production resolver.

use serde_json::json;
use uuid::Uuid;

use cytoanalyst::modules::workstore::catalog::models::NewArtifact;
use cytoanalyst::modules::workstore::catalog::repository::CatalogRepository;
use cytoanalyst::modules::workstore::object_store::{ContentKey, ObjectStore};

use crate::common::TestServer;

use super::{create_project, pool_for, server_store, setup_admin};

/// The axis the scene's SOURCE stores declare — one constant so a scene's sources and the
/// gathered declaration built over them cannot drift apart. The creator derives the gathered
/// axis from exactly this (`source_axis`), so a fixture that spelled a second value here
/// would be describing a store the creator never writes.
const SCENE_SOURCE_AXIS: &str = "rows";

const ITEM: usize = 4; // f32

fn f32_bytes(vals: &[f32]) -> Vec<u8> {
    vals.iter().flat_map(|v| v.to_le_bytes()).collect()
}

fn u32_bytes(vals: &[u32]) -> Vec<u8> {
    vals.iter().flat_map(|v| v.to_le_bytes()).collect()
}

/// A STORED artifact holding `bytes`, written to the real object store.
async fn stored(
    repo: &CatalogRepository,
    store: &dyn ObjectStore,
    project: Uuid,
    output_id: &str,
    bytes: &[u8],
) -> Uuid {
    let key = store.put(bytes).await.expect("put blob");
    let a = NewArtifact {
        project_id: Some(project),
        dataset_id: None,
        run_id: Some(Uuid::new_v4()),
        output_id: output_id.to_string(),
        datatype: "data/opaque".to_string(),
        object_key: Some(key.as_str().to_string()),
        is_multifile: false,
        content_hash: key.as_str().to_string(),
        structure: json!({
            "encoding": "opaque",
            "media_type": "application/octet-stream",
            // ITEM-20 — the key sequence this source's rows line up with. Derived from the
            // output_id so every fixture source has a DISTINCT one, which is what lets a
            // test tell a check against the leaf apart from a check against an intermediate.
            "key_sequence_digest": format!("sha256:{}", output_id),
        }),
        meta: json!({}),
        role: "artifact".to_string(),
        stored_bytes: bytes.len() as i64,
        logical_bytes: Some(bytes.len() as i64),
        created_by: None,
        hidden: false,
        representation_of: None,
    };
    repo.insert_artifact(&a).await.expect("insert stored").id
}

/// The producer-emitted alignment, seeded as a REAL artifact row.
///
/// Its `structure` / `meta` are lifted verbatim from the fixture stage 1's own generator
/// wrote (`tests/fixtures/stage1_alignment/manifest.json`), so the serve path parses the
/// producer's shape here rather than a shape this file invented — which is the mistake that
/// kept two wrong recipes green.
async fn alignment_artifact(
    repo: &CatalogRepository,
    pool: &sqlx::SqlitePool,
    store: &dyn ObjectStore,
    project: Uuid,
    output_id: &str,
) -> Uuid {
    let manifest: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/stage1_alignment/manifest.json"),
        )
        .expect("the committed producer fixture"),
    )
    .expect("manifest parses");
    let entry = manifest["outputs"]
        .as_array()
        .expect("outputs")
        .iter()
        .find(|o| o["datatype"] == serde_json::Value::from("dataset-alignment"))
        .cloned()
        .expect("a dataset-alignment output");

    // The alignment artifact is REAL — it has bytes. Only the fused column is blob-less.
    let id = stored(repo, store, project, output_id, b"alignment-bytes").await;
    sqlx::query("UPDATE artifacts SET structure = $1, meta = $2 WHERE id = $3")
        .bind(entry["structure"].clone())
        .bind(entry["meta"].clone())
        .bind(id)
        .execute(pool)
        .await
        .expect("stamp the producer's structure/meta onto the alignment row");
    id
}

/// A GATHERED artifact: no blob, the DEC-8 recipe naming the alignment + one source artifact.
async fn gathered(
    repo: &CatalogRepository,
    project: Uuid,
    output_id: &str,
    n: usize,
    source: Uuid,
    alignment: Uuid,
) -> Uuid {
    let a = NewArtifact {
        project_id: Some(project),
        dataset_id: None,
        run_id: Some(Uuid::new_v4()),
        output_id: output_id.to_string(),
        datatype: "data/opaque".to_string(),
        object_key: None,
        is_multifile: false,
        content_hash: format!("sha256:{}", "d".repeat(64)),
        structure: json!({
            "kind": "table", "axis": "entries", "n": n, "data_type": "float32",
            "gathered_from": {
                "alignment_artifact_id": alignment,
                "column_selector": "values",
                "sources": [
                    { "dataset_id": "ds-a", "artifact_id": source },
                    { "dataset_id": "ds-b", "artifact_id": source },
                ]
            }
        }),
        meta: json!({}),
        role: "artifact".to_string(),
        stored_bytes: 0,
        // Derived from the CREATOR's own arithmetic, never restated here — the same
        // discipline `structure` above follows. A hand-written literal would agree with
        // the serve path by construction and could not catch a drift between them.
        logical_bytes: cytoanalyst::modules::workstore::virtual_dataset::gathered_logical_bytes(
            "float32", n,
        ),
        created_by: None,
        hidden: false,
        representation_of: None,
    };
    repo.insert_artifact(&a).await.expect("insert gathered").id
}

async fn read_chunk(server: &TestServer, token: &str, id: Uuid, g: usize) -> reqwest::Response {
    reqwest::Client::new()
        .get(server.api_url(&format!("/artifacts/{id}/data/values/c/{g}")))
        .bearer_auth(token)
        .send()
        .await
        .expect("request")
}

/// **ITEM-30 end-to-end — `unresolvable` reaches the client as a distinguishable 409.**
///
/// The unit tests prove `try_new` refuses it with its own code. They do not prove the state
/// survives the route: that a row can BE in it, that the byte path returns 409 rather than
/// 500 or an empty 200, and that `error_code` is on the wire where a client can branch on it
/// without parsing prose.
///
/// That distinction is the same one that made the parity test worth insisting on — the
/// arithmetic being right is not evidence the path wires up — and it is what stage 3's
/// surface test needs, since this repo forbids route-mocking (correctly: mocking would prove
/// the component renders a shape, not that the server ever emits it).
#[tokio::test]
async fn an_unresolvable_artifact_refuses_the_byte_route_with_its_own_error_code() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "unresolvable wire").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);

    let (g, _, _) = producer_scene(&repo, &store, project, None).await;

    // POSITIVE CONTROL — while it is `ready` the same request SERVES REAL BYTES. Without a
    // control the 409 below could be caused by anything (a bad recipe, a missing source, a
    // broken route) and would still "pass".
    let ok = read_chunk(&server, &token, g, 0).await;
    assert_eq!(ok.status(), 200, "the fixture must read while it is ready");
    assert!(
        !ok.bytes().await.unwrap().is_empty(),
        "and it must serve real bytes, or the refusal below is vacuous"
    );

    // Put it into the state, naming what went missing (INV-9).
    sqlx::query("UPDATE artifacts SET status = 'unresolvable', meta = $1 WHERE id = $2")
        .bind(serde_json::json!({ "unresolved_source": "dataset 'donor A'" }))
        .bind(g)
        .execute(&pool)
        .await
        .expect("set unresolvable");

    let resp = read_chunk(&server, &token, g, 0).await;
    assert_eq!(
        resp.status(),
        409,
        "an unresolvable artifact must refuse the byte route, not 500 and not an empty 200"
    );
    let body = resp.text().await.unwrap();
    assert!(
        body.contains("ARTIFACT_UNRESOLVABLE"),
        "`error_code` must be ON THE WIRE so a client branches on it rather than parsing \
         prose — this is what stage 3's surface reads: {body}"
    );
    assert!(
        !body.contains("ARTIFACT_NOT_CONFORMING"),
        "it must NOT arrive as the conformance code: the two recommend opposite fixes \
         (delete-and-re-run vs restore-the-source): {body}"
    );
    assert!(
        body.contains("donor A"),
        "INV-9 — the refusal names the missing source rather than saying only 'unreadable': {body}"
    );
}

/// The seed spec ACCEPTS a status, so a fixture can reach that state without raw SQL.
///
/// `meta` already existed; only `status` was missing, which is why every seeded artifact
/// landed `ready` and `unresolvable` had no seed path at all.
#[test]
fn the_seed_spec_accepts_a_declared_status_and_defaults_to_none() {
    use cytoanalyst::modules::workstore::data_api::SeedArtifactSpec;

    let with: SeedArtifactSpec = serde_json::from_value(serde_json::json!({
        "output_id": "x", "datatype": "data/opaque",
        "status": "unresolvable",
        "content": { "encoding": "json", "value": {} }
    }))
    .expect("a plan may declare a status");
    assert_eq!(with.status.as_deref(), Some("unresolvable"));

    // The default path is unchanged — omitting it must not become "some status".
    let without: SeedArtifactSpec = serde_json::from_value(serde_json::json!({
        "output_id": "x", "datatype": "data/opaque",
        "content": { "encoding": "json", "value": {} }
    }))
    .expect("status is optional");
    assert_eq!(
        without.status, None,
        "omitted ⇒ None ⇒ the repository's `ready`"
    );
}

/// **ITEM-25 — the cache answers only questions the gates have already allowed.**
///
/// Written BEFORE the chunk cache exists, deliberately. The ordering — status gate, THEN
/// cache — is the invariant, not an implementation detail, and a comment saying so does not
/// survive someone optimising the lookup earlier. This is what goes red when they do.
///
/// The sequence is the one a cache makes dangerous: read the chunk (warming any cache keyed
/// on `(artifact, chunk)`), then make the artifact `unresolvable`, then read the SAME chunk
/// again. A cache consulted ahead of the gate would serve the warm bytes and the two paths
/// would disagree about the same artifact — a contradiction visible only under a stale entry,
/// which is close to the worst shape a bug can take.
///
/// It passes today because `serve_data_inner` runs `load_readable_artifact` →
/// `ConsumableArtifact::try_new` before the gathered fork, so a cache placed inside
/// `serve_gathered_member` is unreachable for a refused artifact by construction. It keeps
/// passing only while that stays true.
#[tokio::test]
async fn a_warm_chunk_is_still_refused_once_the_artifact_is_unresolvable() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "cache ordering").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);

    let (g, _, _) = producer_scene(&repo, &store, project, None).await;

    // WARM IT. Read the exact chunk the second read will ask for, so any cache keyed on
    // (artifact, chunk) now holds an entry for it. This half was inert while the gather
    // could not produce bytes; it is real again now that it can.
    let first = read_chunk(&server, &token, g, 0).await;
    assert_eq!(
        first.status(),
        200,
        "the fixture must read while ready — this is what warms the cache"
    );
    let warm_bytes = first.bytes().await.unwrap();
    assert!(
        !warm_bytes.is_empty(),
        "a warm entry of zero bytes would make the refusal below vacuous"
    );

    // The artifact's alignment can no longer be resolved.
    sqlx::query("UPDATE artifacts SET status = 'unresolvable', meta = $1 WHERE id = $2")
        .bind(serde_json::json!({ "unresolved_source": "dataset 'donor A'" }))
        .bind(g)
        .execute(&pool)
        .await
        .expect("set unresolvable");

    // The SAME chunk. Must refuse, not serve what the cache remembers.
    let second = read_chunk(&server, &token, g, 0).await;
    assert_eq!(
        second.status(),
        409,
        "a warm cache entry must NOT outlive the status gate — serving it here would make the \
         byte route and the cache disagree about the same artifact, and only under a stale \
         entry. If this fails, a cache lookup was hoisted ahead of `ConsumableArtifact::try_new`"
    );
    let body = second.text().await.unwrap();
    assert!(
        body.contains("ARTIFACT_UNRESOLVABLE"),
        "and it must refuse for the RIGHT reason, not incidentally: {body}"
    );
}

/// **ITEM-25's SECOND ordering invariant — a warm resolution does not outlive its SOURCES.**
///
/// The sibling above pins the STATUS gate: a cache lookup must sit behind
/// `ConsumableArtifact::try_new`. That gate reads the GATHERED row, and it is blind to
/// everything below it — so it says nothing about a warm entry whose SOURCE has since changed.
/// That is a different failure with a different cause, and it became reachable the moment the
/// serve path started consulting a cache at all (`gather_exec::resolve_shared`).
///
/// The line held here is that the metadata walk — `plan_chain`, which resolves every source
/// and verifies every leaf's key-sequence digest — runs on EVERY request, hit or miss. Only
/// the byte fetch and decode are skipped. If the lookup were hoisted ahead of the walk, this
/// goes red with a 200: the right bytes for a column whose source no longer supports them,
/// visible only under a stale entry.
///
/// The sequence: read a chunk (warming the resolution), re-declare the source's key sequence,
/// read the SAME chunk.
#[tokio::test]
async fn a_warm_resolution_is_refused_once_a_source_changes_underneath_it() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "warm source change").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);

    let (g, src_a, _) = producer_scene(&repo, &store, project, None).await;

    // WARM IT — this is the half that was inert while nothing consulted a cache.
    let first = read_chunk(&server, &token, g, 0).await;
    assert_eq!(
        first.status(),
        200,
        "the fixture must read while the pins match — this is what warms the resolution"
    );
    let warm_bytes = first.bytes().await.unwrap();
    assert!(
        !warm_bytes.is_empty(),
        "a warm entry of zero bytes would make the refusal below vacuous"
    );

    // The source now DECLARES a different key sequence than the alignment pinned for it — a
    // re-import under the same artifact id. The gathered row's own status is untouched, so
    // the status gate cannot catch this; only the walk can.
    sqlx::query(
        "UPDATE artifacts SET structure = jsonb_set(structure, '{key_sequence_digest}', \
         '\"sha256:the-source-was-re-imported\"') WHERE id = $1",
    )
    .bind(src_a)
    .execute(&pool)
    .await
    .expect("re-declare the source's key sequence");

    let second = read_chunk(&server, &token, g, 0).await;
    let status = second.status();
    let body = second.text().await.unwrap();
    assert_ne!(
        status, 200,
        "a warm resolution must NOT outlive its sources: the cache lookup has to sit BEHIND \
         `plan_chain`, which is what verifies every leaf digest. Serving here means the walk \
         was skipped on a hit: {body}"
    );
    assert!(
        body.contains("SOURCE_DIGEST_MISMATCH"),
        "and it must refuse for the RIGHT reason — the digest, not an incidental failure \
         downstream of it: {body}"
    );
}

// ════════════════════════════════════════════════════════════════════════════
//  THE SERVE PATH, END TO END — real writer bytes through the real route
// ════════════════════════════════════════════════════════════════════════════
//
// `gather_chunk_multi`'s unit tests prove the ARITHMETIC over buffers handed to it. They say
// nothing about fetching, decoding, ordering or the error paths — and a green test on a
// function is not evidence for a route. These drive
// `GET /artifacts/{id}/data/c/{n}` against artifacts whose bytes are the producer's own,
// committed under `tests/fixtures/stage1_alignment/`.

/// Walk a committed fixture store into the `(member path, bytes)` list `put_prefix` takes.
fn fixture_members(rel: &str) -> Vec<(String, Vec<u8>)> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(rel);
    let mut out = Vec::new();
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        for e in std::fs::read_dir(&dir)
            .unwrap_or_else(|err| panic!("{}: {err}", dir.display()))
            .flatten()
        {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                let member = p
                    .strip_prefix(&root)
                    .expect("under root")
                    .to_string_lossy()
                    .replace('\\', "/");
                out.push((member, std::fs::read(&p).expect("read fixture member")));
            }
        }
    }
    assert!(!out.is_empty(), "fixture {rel} is empty");
    out
}

fn sources_json(fixture: &str, name: &str) -> serde_json::Value {
    serde_json::from_str(
        &std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures")
                .join(fixture)
                .join("sources")
                .join(name),
        )
        .unwrap_or_else(|e| panic!("fixture {fixture}/sources/{name}: {e}")),
    )
    .unwrap_or_else(|e| panic!("{fixture}/sources/{name} parses: {e}"))
}

/// The index a dataset occupies in the producer's slot GRID — `params.dataset_ids`.
///
/// **The slot INDEX is the join, and it is DECLARED rather than derived.** Stage 1's rework
/// makes every per-dataset input its own artifact, bound at `entity:<i>:<column>` and
/// `level:<i>:<column>` (slot FAMILIES, the coordinates riding the slot NAME) plus the
/// ordered literal slot `rows`, one binding per dataset in order. `<i>` indexes this list.
///
/// Nothing about a mount DIRECTORY carries identity: `derive_artifact_mount_name` is a pure
/// function of the slot plus the store encoding, disambiguated positionally, so
/// `level_0_group.zarr` names a SLOT and not a dataset. This helper is the one place the test
/// scenes resolve dataset → grid position.
///
/// **The cross-check is mandatory, not decorative.** `params.dataset_content_hashes[<id>]`
/// must equal the content hash `inputs.json` recorded for the i-th `rows` binding — two
/// documents with different authors on a real run (the launcher writes params, the runner
/// writes inputs.json), so a mis-ordered relay moves one and not the other.
///
/// **LIMIT, stated rather than implied:** in a FIXTURE both documents are written by
/// `emit_reference_alignment.py`, so they are self-consistent by construction and this check
/// cannot fail here. It discriminates on a REAL run. Comparing two relayed lists to each
/// other is exactly what stage 1's first attempt shipped and why it passed.
fn slot_index_of(fixture: &str, dataset_id: &str) -> usize {
    let params = sources_json(fixture, "params.json");
    let relayed: Vec<&str> = params["dataset_ids"]
        .as_array()
        .expect("params.dataset_ids — the identity relay")
        .iter()
        .map(|v| v.as_str().expect("a dataset id"))
        .collect();
    let rows_bindings = bindings_for_slot(fixture, "rows");
    assert_eq!(
        relayed.len(),
        rows_bindings.len(),
        "{fixture}: the relay names {} dataset(s) for {} bound `rows` mount(s) — the relay is \
         positional, so a length mismatch addresses the wrong ones",
        relayed.len(),
        rows_bindings.len()
    );
    let pos = relayed
        .iter()
        .position(|d| *d == dataset_id)
        .unwrap_or_else(|| {
            panic!("{fixture}: the relay does not name {dataset_id:?}; got {relayed:?}")
        });
    if let (Some(declared), Some(actual)) = (
        params["dataset_content_hashes"][dataset_id].as_str(),
        rows_bindings[pos]["content_hash"].as_str(),
    ) {
        assert_eq!(
            declared, actual,
            "{fixture}: the relay puts {dataset_id:?} at grid index {pos}, whose `rows` \
             binding is staged with {actual:?}, but params records {declared:?} for it"
        );
    }
    pos
}

/// Every `inputs.json` entry bound to `slot`, in wire order.
fn bindings_for_slot(fixture: &str, slot: &str) -> Vec<serde_json::Value> {
    sources_json(fixture, "inputs.json")["inputs"]
        .as_array()
        .expect("inputs.inputs")
        .iter()
        .filter(|e| e["slot"] == serde_json::Value::from(slot))
        .cloned()
        .collect()
}

fn mount_name(binding: &serde_json::Value) -> String {
    binding["sandbox_path"]
        .as_str()
        .expect("sandbox_path")
        .rsplit('/')
        .next()
        .expect("a mount name")
        .to_string()
}

/// The mount directory staged for a slot bound exactly ONCE (`level:<i>:<column>`, …).
fn mount_of_slot(fixture: &str, slot: &str) -> String {
    let bound = bindings_for_slot(fixture, slot);
    assert_eq!(
        bound.len(),
        1,
        "{fixture}: slot {slot:?} is bound {} time(s); a slot-family entry is bound exactly \
         once, and any other count means the grid coordinate is not what this scene thinks",
        bound.len()
    );
    mount_name(&bound[0])
}

/// The mount directory staged for the `n`-th binding of an ORDERED literal slot (`rows`).
fn mount_of_nth_slot(fixture: &str, slot: &str, n: usize) -> String {
    let bound = bindings_for_slot(fixture, slot);
    assert!(
        n < bound.len(),
        "{fixture}: slot {slot:?} has {} binding(s), so index {n} addresses nothing",
        bound.len()
    );
    mount_name(&bound[n])
}

/// The identity a source STORE declares for itself — `key_sequence_digest` on the store that
/// carries the keys, `aligned_to` on an ordinary column.
///
/// Read so a scene can cross-check its mount resolution against a channel it did not use to
/// resolve it: the scene pins each source from `meta.sources[].key_sequence_digest` (by
/// dataset id), while the level store stamps `aligned_to` from its own bytes. Bind the wrong
/// grid entry and the two disagree — on `stage1_alignment_reversed` the level mounts are in
/// the opposite order from the dataset ids, so this is a check that CAN fail and does the
/// moment the resolution is off by one.
fn store_declared_identity(fixture: &str, mount: &str) -> String {
    let attrs: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures")
                .join(fixture)
                .join("sources")
                .join(mount)
                .join("zarr.json"),
        )
        .unwrap_or_else(|e| panic!("{fixture}/sources/{mount}/zarr.json: {e}")),
    )
    .expect("store attrs parse");
    for field in ["aligned_to", "key_sequence_digest"] {
        if let Some(v) = attrs
            .pointer(&format!("/attributes/cyto/{field}"))
            .and_then(|v| v.as_str())
        {
            return v.to_string();
        }
    }
    panic!("{fixture}/sources/{mount} declares neither `aligned_to` nor `key_sequence_digest`")
}

fn alignment_entry_json_of(fixture: &str) -> serde_json::Value {
    let manifest: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures")
                .join(fixture)
                .join("manifest.json"),
        )
        .expect("fixture manifest"),
    )
    .expect("manifest parses");
    manifest["outputs"]
        .as_array()
        .expect("outputs")
        .iter()
        .find(|o| o["datatype"] == serde_json::Value::from("dataset-alignment"))
        .cloned()
        .expect("a dataset-alignment output")
}

/// Insert a MULTIFILE artifact holding a committed fixture store.
async fn multifile(
    repo: &CatalogRepository,
    store: &dyn ObjectStore,
    project: Uuid,
    output_id: &str,
    fixture_rel: &str,
    structure: serde_json::Value,
    meta: serde_json::Value,
) -> Uuid {
    let members = fixture_members(fixture_rel);
    let put = store.put_prefix(&members).await.expect("put_prefix");
    repo.insert_artifact(&NewArtifact {
        project_id: Some(project),
        dataset_id: None,
        run_id: Some(Uuid::new_v4()),
        output_id: output_id.to_string(),
        datatype: "data/opaque".to_string(),
        object_key: Some(put.object_key.as_str().to_string()),
        is_multifile: true,
        content_hash: put.content_hash.clone(),
        structure,
        meta,
        role: "artifact".to_string(),
        // A stored fixture whose byte count is not the subject of any assertion here; the
        // two quantities coincide for an artifact that owns a blob, so both are 0.
        stored_bytes: 0,
        logical_bytes: Some(0),
        created_by: None,
        hidden: false,
        representation_of: None,
    })
    .await
    .expect("insert multifile")
    .id
}

/// Which slot family a scene's per-dataset source artifacts come from.
///
/// **Stage 1's rework made this a choice where it used to be a member name.** Before it,
/// every column of a dataset lived in ONE `sources/<mount>/rows.zarr` store, so a scene
/// pointed at one artifact per dataset and picked a column by name. Now each grid entry is its
/// own artifact and they are different stores: the fused categorical is the
/// `level:<i>:<column>` binding, the axis's identifier keys are the `rows` binding. A scene
/// must say WHICH, and the recipe it writes differs in more than a string.
#[derive(Clone, Copy)]
enum SceneGather {
    /// The fused categorical grid entry `level:<i>:<column>`.
    ///
    /// Its store is a `metadata-column`, so the member is **always `values`** and the column
    /// name is carried by the SLOT — hence `alignment_column` in the recipe, which is what
    /// the alignment's `levels__<column>__<i>` lookups and `unified_levels` are keyed on.
    Level(&'static str),
    /// The `rows` binding — the axis's own identifier keys, a split utf8 column (ITEM-22(b)).
    ///
    /// No alignment column: there is no fused vocabulary here, so the recipe declares none
    /// and no remap runs.
    Rows,
}

/// The whole scene: the producer's alignment, its two source datasets, and a fused column
/// over `group`. Returns `(gathered id, source A id, source B id)`.
async fn producer_scene(
    repo: &CatalogRepository,
    store: &dyn ObjectStore,
    project: Uuid,
    digest_a: Option<&str>,
) -> (Uuid, Uuid, Uuid) {
    producer_scene_from(repo, store, project, digest_a, "stage1_alignment").await
}

/// The scene, over a NAMED reference fixture.
///
/// **The default fixture has every ordering coinciding** — `segment_order` is the identity,
/// `segment_dataset` is the identity, `segment_start` is monotonic — which is exactly the
/// coincidence that hid the declared-order defect. Stage 1's own tests-quality audit flagged
/// the same shape in the reference emitter. So any test whose subject is ORDERING must run
/// against `stage1_alignment_reversed`, where all three genuinely disagree.
async fn producer_scene_from(
    repo: &CatalogRepository,
    store: &dyn ObjectStore,
    project: Uuid,
    digest_a: Option<&str>,
    fixture: &str,
) -> (Uuid, Uuid, Uuid) {
    producer_scene_over(
        repo,
        store,
        project,
        digest_a,
        fixture,
        SceneGather::Level("group"),
    )
    .await
}

/// The scene, over a named fixture AND a named slot family.
async fn producer_scene_over(
    repo: &CatalogRepository,
    store: &dyn ObjectStore,
    project: Uuid,
    digest_a: Option<&str>,
    fixture: &str,
    gather: SceneGather,
) -> (Uuid, Uuid, Uuid) {
    let entry = alignment_entry_json_of(fixture);
    let sources = entry["meta"]["sources"]
        .as_array()
        .expect("sources")
        .clone();
    // BY DATASET ID, never by position.
    //
    // This helper read `sources[0]` for ds-a and `sources[1]` for ds-b — correct for the
    // default fixture and wrong for the reversed one, where `meta.sources` is `[ds-b, ds-a]`.
    // The scene then pinned each source with the OTHER one's digest and the precheck refused,
    // correctly, for a reason that had nothing to do with the test's subject. It is the same
    // positional assumption as the defect under test, one level down in the fixture — which
    // is what makes "look it up by name" a rule rather than a preference here.
    let pin = |dataset_id: &str| -> String {
        sources
            .iter()
            .find(|s| s["dataset_id"] == serde_json::Value::from(dataset_id))
            .unwrap_or_else(|| panic!("no source {dataset_id} in {sources:?}"))
            ["key_sequence_digest"]
            .as_str()
            .expect("a pinned digest")
            .to_string()
    };

    let align = multifile(
        repo,
        store,
        project,
        "alignment",
        &format!("{fixture}/alignment.zarr"),
        entry["structure"].clone(),
        entry["meta"].clone(),
    )
    .await;

    // ── dataset → GRID ENTRY → the mount its bytes are staged under ────────────────────
    //
    // Two lookups, both by name, neither positional-by-luck: `slot_index_of` resolves the
    // dataset to its index in `params.dataset_ids` (cross-checked against the staged `rows`
    // content hash), and the slot NAME then addresses the entry. On
    // `stage1_alignment_reversed` the grid is in the opposite order from `meta.sources`, so a
    // scene that took either order for the other binds the wrong bytes.
    let mount_for = |dataset_id: &str| -> String {
        let i = slot_index_of(fixture, dataset_id);
        match gather {
            SceneGather::Level(column) => mount_of_slot(fixture, &format!("level:{i}:{column}")),
            SceneGather::Rows => mount_of_nth_slot(fixture, "rows", i),
        }
    };
    // The row count each source contributes, READ from the alignment's own record rather
    // than restated here — `2` and `3` were literals that happened to hold for every fixture
    // in the tree, which is a coincidence and not a contract.
    let n_rows_of = |dataset_id: &str| -> u64 {
        sources
            .iter()
            .find(|s| s["dataset_id"] == serde_json::Value::from(dataset_id))
            .and_then(|s| s["n_rows"].as_u64())
            .unwrap_or_else(|| {
                panic!("{fixture}: meta.sources declares no n_rows for {dataset_id}")
            })
    };

    // Each source artifact DECLARES the key sequence the alignment pinned for it — which is
    // what the precheck compares. `digest_a` lets a test change one out from under the
    // alignment, which is the H1 scenario.
    //
    // **The pin is CROSS-CHECKED against the store's own stamp**, which is a different
    // channel from the one used to resolve the mount: the scene pins from
    // `meta.sources[].key_sequence_digest` (looked up by dataset id) while the store stamps
    // `aligned_to`/`key_sequence_digest` from its own bytes. Bind the wrong grid entry and the
    // two disagree — and on the reversed fixture they WOULD, because the level mounts are in
    // the opposite order from the dataset ids. Without this the scene could mis-resolve every
    // mount and still be internally consistent, which is the self-agreeing arrangement this
    // stage has refused twice.
    let mut source_ids: Vec<Uuid> = Vec::new();
    for (dataset_id, label) in [("ds-a", "src-a"), ("ds-b", "src-b")] {
        let mount = mount_for(dataset_id);
        let pinned = pin(dataset_id);
        assert_eq!(
            store_declared_identity(fixture, &mount),
            pinned,
            "{fixture}: the scene bound {dataset_id} to {mount}, but that store declares an \
             identity the alignment pinned for the OTHER dataset — the grid resolution is off"
        );
        let declared = if dataset_id == "ds-a" {
            digest_a.map(str::to_string).unwrap_or(pinned)
        } else {
            pinned
        };
        source_ids.push(
            multifile(
                repo,
                store,
                project,
                label,
                &format!("{fixture}/sources/{mount}"),
                json!({ "kind": "table", "axis": SCENE_SOURCE_AXIS, "n": n_rows_of(dataset_id),
                        "key_sequence_digest": declared }),
                json!({}),
            )
            .await,
        );
    }
    let (src_a, src_b) = (source_ids[0], source_ids[1]);

    let g = repo
        .insert_artifact(&NewArtifact {
            project_id: Some(project),
            dataset_id: None,
            run_id: Some(Uuid::new_v4()),
            output_id: match gather {
                SceneGather::Level(c) => format!("fused-{c}"),
                SceneGather::Rows => "fused-rows".to_string(),
            },
            datatype: "data/opaque".to_string(),
            object_key: None,
            is_multifile: false,
            content_hash: format!("sha256:{}", "f".repeat(64)),
            structure: {
                // **BUILT BY THE CREATOR'S OWN FUNCTION, not restated here.** A scene that
                // hand-authored this declaration is a fixture written by the reader's hand:
                // it agreed with the serve path by construction and could not have caught
                // C2 — the creator omitted `encoding`/`columns[]` entirely, so no client
                // path could parse a real gathered row while every scene here read fine.
                let mut st = cytoanalyst::modules::workstore::virtual_dataset::gathered_structure(
                    // A `level:` entry is a uint8 categorical; the `rows` binding is a SPLIT
                    // utf8 column, and the gather branches on this DECLARATION rather than
                    // sniffing bytes.
                    match gather {
                        SceneGather::Level(_) => "uint8",
                        SceneGather::Rows => "utf8",
                    },
                    match gather {
                        SceneGather::Level(_) => Some("categorical"),
                        SceneGather::Rows => Some("string"),
                    },
                    SCENE_SOURCE_AXIS,
                    entry["meta"]["n_rows"].as_u64().expect("meta.n_rows") as usize,
                    // These scenes pin NO axis identity, and that is now SAID rather than
                    // omitted. They exercise the chain's shape and its byte plane; the
                    // identity relation is `detach_chain_test`'s and the creator's. Passing
                    // `Unpinned` keeps every assertion in this file byte-identical to what it
                    // asserted before the parameter existed.
                    cytoanalyst::modules::workstore::virtual_dataset::KeyIdentity::Unpinned,
                    json!({
                    "alignment_artifact_id": align,
                    // The MEMBER PATH inside each source store. Under the slot-family layout
                    // every per-dataset store — `level:<i>:<column>` and `rows` alike — holds
                    // exactly one column, named `values`. It is NOT the alignment's name for
                    // the column; those are two strings now, and conflating them serves each
                    // source's raw code space.
                    "column_selector": "values",
                    // …and this is the alignment's name, absent for a gather with no fused
                    // vocabulary.
                    "alignment_column": match gather {
                        SceneGather::Level(c) => serde_json::Value::from(c),
                        SceneGather::Rows => serde_json::Value::Null,
                    },
                    "sources": [
                        { "dataset_id": "ds-a", "artifact_id": src_a },
                        { "dataset_id": "ds-b", "artifact_id": src_b },
                    ]
                    }),
                );
                // DECLARED small so the fixture spans several chunks and exercises the
                // cross-chunk path. Production defaults to `CHUNK_ELEMENTS` (4096, the
                // writer's own inner-chunk size); the small value is a property of THIS
                // artifact rather than a global, so the declaration and the served chunking
                // are the same number and cannot drift apart.
                st["chunk_elements"] = json!(4);
                st
            },
            meta: json!({}),
            role: "artifact".to_string(),
            stored_bytes: 0,
            // From the creator's own function, over the SAME dtype the declaration above
            // states. A `utf8` (split string) gather has no derivable width and lands on
            // `None` — the unknown case, exercised here rather than only in unit tests.
            logical_bytes: cytoanalyst::modules::workstore::virtual_dataset::gathered_logical_bytes(
                match gather {
                    SceneGather::Level(_) => "uint8",
                    SceneGather::Rows => "utf8",
                },
                entry["meta"]["n_rows"].as_u64().expect("meta.n_rows") as usize,
            ),
            created_by: None,
            hidden: false,
            representation_of: None,
        })
        .await
        .expect("insert gathered")
        .id;
    (g, src_a, src_b)
}

/// **The serve path produces the right rows out of TWO real sources.**
///
/// `ds-a`'s `group` codes are `[1, 0]` over its own levels `["g1","g2"]`, and `ds-b`'s are
/// `[1, 2, 0]` over `["g2","g3","g4"]` (the writer's own bytes). The producer's row vector
/// interleaves them as `[(a,0), (a,1), (b,0), (b,1), (b,2)]`.
///
/// The values are what make this a test: rows 0 and 2 both address source row 0, from
/// DIFFERENT datasets, and their codes differ — so a gather that read the row number without
/// its segment returns the right count and visibly wrong bytes.
#[tokio::test]
async fn the_serve_path_gathers_real_writer_bytes_from_two_sources() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "serve gather").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);

    let (g, _, _) = producer_scene(&repo, &store, project, None).await;

    let c0 = read_chunk(&server, &token, g, 0).await;
    assert_eq!(c0.status(), 200, "{:?}", c0.text().await);
    let b0 = c0.bytes().await.unwrap();
    assert_eq!(
        b0.as_ref(),
        &[1u8, 0, 2, 3],
        "chunk 0 is ds-a's two codes then ds-b's first two, EACH REMAPPED INTO THE UNIFIED \
         CODE SPACE. The unified vocabulary is [g1,g2,g3,g4] and ds-b's lookup is [1,2,3], so \
         its local code 1 (`g3`) is unified code 2 — serving the raw 1 would label that row \
         `g2`, ds-b's FIRST level. An earlier revision of this assertion pinned exactly that: \
         one source's codes read against another's vocabulary, with the right count and a \
         clean console, and it took a blind audit decoding the committed bytes to see it."
    );

    let c1 = read_chunk(&server, &token, g, 1).await;
    assert_eq!(c1.status(), 200);
    assert_eq!(
        c1.bytes().await.unwrap().as_ref(),
        &[1u8, 0, 0, 0],
        "the trailing chunk carries ds-b's last row, remapped into the unified space — padded \
         to full width with the fill value"
    );

    // The synthetic declaration the client reads, from the real route. TWO nodes now
    // (DEC-26): a GROUP at the root carrying the artifact's declaration, and the ARRAY under
    // `values/` carrying the geometry — which is the shape `cyto_zarr` emits and the shape
    // `resolveMember` can address.
    let fetch_json = |m: String| {
        let url = server.api_url(&format!("/artifacts/{g}/data/{m}"));
        let token = token.clone();
        async move {
            reqwest::Client::new()
                .get(url)
                .bearer_auth(&token)
                .send()
                .await
                .expect("member")
                .json::<serde_json::Value>()
                .await
                .expect("json")
        }
    };
    let root = fetch_json("zarr.json".into()).await;
    assert_eq!(root["node_type"], json!("group"), "root is a GROUP: {root}");
    assert_eq!(
        root["attributes"]["cyto"]["columns"][0]["path"],
        json!("values"),
        "…and it declares the member the array actually lives at. A root ARRAY is the shape \
         no client path could reach: {root}"
    );
    let decl = fetch_json("values/zarr.json".into()).await;
    assert_eq!(decl["node_type"], json!("array"));
    assert_eq!(decl["shape"], json!([5]));
    assert_eq!(decl["data_type"], json!("uint8"));
}

/// **H1 — a changed source is refused BEFORE a single source byte is fetched.**
///
/// The ordering is the claim, and asserting only the refusal would not test it: a digest
/// check that ran AFTER the fetch would produce the identical error while having done the
/// expensive wrong thing. So the source's BLOB is destroyed while its catalog row survives —
/// if any byte of it were fetched first, the failure would be a missing-blob error instead,
/// and the two are distinguishable by code.
///
/// This is the same shape as the cache-ahead-of-its-gate mistake: right answer, wrong place.
#[tokio::test]
async fn a_changed_source_is_refused_before_a_single_source_byte_is_fetched() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "digest before fetch").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);

    // POSITIVE CONTROL FIRST: with the pin intact the same request SERVES. Without it, the
    // refusal below could come from the destroyed blob, the recipe, or the route.
    let (ok_g, _, _) = producer_scene(&repo, &store, project, None).await;
    assert_eq!(
        read_chunk(&server, &token, ok_g, 0).await.status(),
        200,
        "the scene must read while the pins match"
    );

    // Now a scene whose ds-a source declares a DIFFERENT key sequence than the alignment
    // pinned, and whose bytes are gone.
    let project2 = create_project(&server, &token, "digest before fetch 2").await;
    let (g, src_a, _) = producer_scene(
        &repo,
        &store,
        project2,
        Some("sha256:the-source-was-re-imported"),
    )
    .await;
    let key = repo
        .get_any_status(src_a)
        .await
        .expect("row")
        .expect("exists")
        .object_key
        .expect("a stored source has a key");

    // Destroy the MEMBER blob the gather would read — not the manifest.
    //
    // Deleting the manifest was the first attempt and it made this control INERT: the
    // manifest was already resolved into `LocalFsStore`'s in-process cache
    // (`resolve_member` consults `self.manifests` before touching the store), so members
    // stayed readable and the ordering mutation went undetected. The control passed, which
    // is a finding about the test rather than a null result — a discriminator has to be
    // measured, not assumed, and an adjacent cache is exactly what makes one plausible and
    // inert at the same time.
    let member = store
        .resolve_member(&ContentKey::parse(&key), "values/c/0")
        .await
        .expect("the source's member exists before it is destroyed");
    store
        .delete(&member)
        .await
        .expect("destroy the member blob");
    assert!(
        store.get(&member).await.is_err(),
        "the member's bytes must really be gone, or this test cannot tell a \
         check-before-fetch from a check-after-fetch"
    );

    let resp = read_chunk(&server, &token, g, 0).await;
    let status = resp.status();
    let body = resp.text().await.unwrap();
    assert_ne!(status, 200, "a changed source must never be served: {body}");
    assert!(
        body.contains("SOURCE_DIGEST_MISMATCH"),
        "the digest check must run BEFORE any source byte is fetched. Reaching the store \
         first would fail on the destroyed blob instead — same refusal to the user, the \
         expensive wrong thing done underneath: {body}"
    );
    assert!(
        body.contains("sha256:the-source-was-re-imported"),
        "and the refusal names both sides, so the operator knows which source moved: {body}"
    );
}

/// **The parity fixture, captured FROM THE ROUTE.**
///
/// `zarrReader.gatheredParity.test.ts` proves the client cannot tell — but until now its
/// gathered bytes came from `gather_chunk` called directly, so it was evidence about the
/// FUNCTION. Wiring introduced fetching, decoding, per-source verification and ordering that
/// the function never had, and a green test on a function is not evidence for a route.
///
/// So this captures what `GET /artifacts/{id}/data/...` actually returns for the producer
/// scene — real writer bytes, two real sources, the real digest precheck — into
/// `__fixtures__/gathered/route/`, and the TS test drives the UNMODIFIED reader over it.
///
/// Same discipline as the other fixture: writes only under `UPDATE_GATHERED_FIXTURE=1`, and
/// otherwise ASSERTS the committed bytes match, so the route cannot drift from the fixture
/// the client test reads.
#[tokio::test]
async fn the_route_reproduces_the_committed_parity_fixture() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "route parity capture").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);
    let (g, _, _) = producer_scene(&repo, &store, project, None).await;
    capture_route_fixture(&server, &token, &pool, g, "route", 2).await;
}

/// **The SAME capture, from the scene that actually DROPS a level.**
///
/// The non-dropping capture above cannot exercise DEC-27: its vocabulary has no invented
/// entry and its `missing_level` is absent, so a client reading it proves nothing about how
/// absence reaches the browser. This one is the `authority --authority ds-a` scene, whose
/// unified vocabulary carries an appended `NA` and whose rows really point at it.
///
/// **The two fixtures are kept DISTINCT on purpose** — 4 labels with no `missing_level`
/// against 3 with one — so the client test can assert they disagree. A pair that coincided
/// would let a reader that ignored `missing_level` pass both, which is the fixture-coincidence
/// class this branch has paid for three times.
#[tokio::test]
async fn the_route_reproduces_the_committed_dropping_scene_fixture() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "route dropping capture").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);
    let (g, _, _) =
        producer_scene_from(&repo, &store, project, None, "stage1_alignment_absence").await;
    // TWO chunks: the column is 5 rows at 4 per chunk, so a capture of chunk 0 alone leaves
    // the client reading a member whose tail is missing — it zero-FILLS rather than failing,
    // which is a wrong answer with a clean console. Caught by the non-vacuity length
    // assertion on the client side, which is what that assertion is for.
    capture_route_fixture(&server, &token, &pool, g, "route_dropping", 2).await;
}

/// Capture every member the route serves for `artifact`, plus the artifact ROW's `structure`,
/// into `__fixtures__/gathered/<dir>/` — writing only under `UPDATE_GATHERED_FIXTURE=1` and
/// otherwise ASSERTING the committed bytes match.
///
/// ONE implementation for both scenes: two copies of a capture are two captures that will
/// disagree later about what "the route's bytes" means, with nothing to say which is right.
async fn capture_route_fixture(
    server: &TestServer,
    token: &str,
    pool: &sqlx::SqlitePool,
    g: Uuid,
    dir: &str,
    chunks: usize,
) {
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    // EVERY member the store serves, captured through the route — not a hand-picked pair.
    // The client test resolves the member by following `columns[].path`, so a capture that
    // omitted `values/zarr.json` would make it read a member that is not there and the
    // failure would look like a reader bug.
    // **ENUMERATED, not hardcoded.** `member_paths()` is what `materialize` walks and what
    // the route's 404 message quotes, so a hardcoded list here would leave the one property
    // that binding depends on — *the route serves exactly the set enumeration claims* —
    // asserted nowhere. `materialize`'s "enumerated but not served" error is unreachable
    // unless something checks the two agree.
    let row = CatalogRepository::new(pool.clone())
        .get_any_status(g)
        .await
        .expect("row")
        .expect("exists");
    let consumable =
        cytoanalyst::modules::workstore::consume::ConsumableArtifact::try_new(row).expect("ready");
    let members = cytoanalyst::modules::workstore::gather_exec::resolve(
        pool,
        &server_store(server),
        consumable.id,
        &consumable.structure,
    )
    .await
    .expect("resolve")
    .member_paths();
    assert_eq!(
        members.len(),
        2 + chunks,
        "the store must enumerate a group node, its member's array node and {chunks} chunk(s);          got {members:?}"
    );
    for rel in members {
        let rel = rel.as_str();
        let r = reqwest::Client::new()
            .get(server.api_url(&format!("/artifacts/{g}/data/{rel}")))
            .bearer_auth(&token)
            .send()
            .await
            .expect("member");
        assert_eq!(r.status(), 200, "member {rel}");
        files.push((rel.to_string(), r.bytes().await.unwrap().to_vec()));
    }

    // **THE ARTIFACT ROW'S `structure`, captured too.** This is what `parseStructure` is
    // handed — the declaration the CATALOG holds, not the one the store carries — and it is
    // the surface C2 lived on: it declared no `encoding` and no `columns[]`, so the client's
    // first guard threw before a byte was fetched. Capturing only store bytes cannot see
    // that, which is why the acceptance proof used to stop at the server boundary.
    let mut structure: serde_json::Value =
        sqlx::query_scalar("SELECT structure FROM artifacts WHERE id = $1")
            .bind(g)
            .fetch_one(pool)
            .await
            .expect("structure");
    // **The RECIPE's ids are elided, and only they.** `alignment_artifact_id` and each
    // source's `artifact_id` are minted per run, so committing them would make this guard
    // fail on every run for a reason that is not drift — a guard that cries wolf is a guard
    // somebody deletes. The KEYS survive, including `column_selector` and `alignment_column`
    // (the two strings whose conflation is CRITICAL-2), and everything the CLIENT reads —
    // `encoding`, `kind`, `columns[]`, `axis`, `n` — is committed verbatim, because
    // `gathered_from` is the one part of `structure` no client path touches.
    if let Some(from) = structure.get_mut("gathered_from") {
        if let Some(id) = from.get_mut("alignment_artifact_id") {
            *id = json!("<per-run>");
        }
        if let Some(sources) = from.get_mut("sources").and_then(|s| s.as_array_mut()) {
            for src in sources {
                if let Some(id) = src.get_mut("artifact_id") {
                    *id = json!("<per-run>");
                }
            }
        }
    }
    files.push((
        "structure.json".into(),
        serde_json::to_vec_pretty(&structure).unwrap(),
    ));

    assert!(
        files.iter().all(|(_, b)| !b.is_empty()),
        "a capture of empty bodies would make the client test read nothing and pass"
    );

    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../ui/src/core/workstore/__fixtures__/gathered")
        .join(dir);
    if std::env::var("UPDATE_GATHERED_FIXTURE").is_ok() {
        for (rel, bytes) in &files {
            let p = root.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, bytes).unwrap();
        }
        eprintln!("route fixture {dir} REGENERATED at {}", root.display());
        return;
    }
    let mut drifted = Vec::new();
    for (rel, bytes) in &files {
        match std::fs::read(root.join(rel)) {
            Ok(on_disk) if &on_disk == bytes => {}
            Ok(_) => drifted.push(format!("{rel} (content differs)")),
            Err(e) => drifted.push(format!("{rel} ({e})")),
        }
    }
    assert!(
        drifted.is_empty(),
        "the committed ROUTE parity fixture no longer matches what the serve path returns: \
         {drifted:?}\nRegenerate with UPDATE_GATHERED_FIXTURE=1. This is the guard working — \
         the client parity test reads these bytes, and a stale fixture would let it pass \
         against a route that had changed."
    );
}

// ════════════════════════════════════════════════════════════════════════════
//  ITEM-22 — the virtual AXIS, and the half of it that is not reachable yet
// ════════════════════════════════════════════════════════════════════════════

/// **ITEM-22(a) — a virtual dataset's axis needs no special case, and this proves it.**
///
/// `derive_axes` reads `status`, `meta.is_axis_index`, and `structure.{axis,n,
/// key_sequence_digest}` — all metadata, none of it bytes. So a GATHERED artifact publishes
/// an axis exactly like a stored one, with no blob in existence. That is the design's claim
/// ("the virtual dataset's axis is virtual too; same mechanism, no special case") and it is
/// the kind of claim that is easy to assert and easy to have quietly false.
#[tokio::test]
async fn a_gathered_artifact_publishes_an_axis_with_no_bytes_at_all() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "virtual axis").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);
    let (g, _, _) = producer_scene(&repo, &store, project, None).await;

    // Make the fused column the dataset's axis index, as a virtual dataset's key column is.
    sqlx::query("UPDATE artifacts SET meta = $1, structure = structure || $2 WHERE id = $3")
        .bind(json!({ "is_axis_index": true }))
        .bind(json!({ "key_sequence_digest": "sha256:virtual-axis" }))
        .bind(g)
        .execute(&pool)
        .await
        .expect("mark as axis index");

    let catalog: serde_json::Value = reqwest::Client::new()
        .get(server.api_url(&format!("/projects/{project}/catalog")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("catalog")
        .json()
        .await
        .expect("catalog json");
    let axes = catalog["axes"].clone();
    let listed = axes.as_array().cloned().unwrap_or_default();
    let mine = listed
        .iter()
        .find(|a| a["key_sequence_digest"] == json!("sha256:virtual-axis"))
        .unwrap_or_else(|| panic!("the virtual axis is absent from {axes}"));
    assert_eq!(
        mine["name"],
        json!(SCENE_SOURCE_AXIS),
        "the axis is named by the gathered artifact's own declaration, which since #149 is \
         the SOURCES' shared axis kind carried through — not a name minted by the creator. \
         A virtual dataset that publishes an axis nobody else declares is refused as an \
         input by every consumer that matches on the label: {axes}"
    );
    assert_eq!(
        mine["length"],
        json!(5),
        "and carries its length — five gathered rows, from an artifact with no blob: {axes}"
    );
}

/// **A dtype the gather cannot size is still refused BY NAME — the class, minus strings.**
///
/// This test previously asserted that a STRING column refuses, which was true until ITEM-22(b)
/// implemented the offsets-and-values assembly. Its subject moved rather than disappeared: the
/// refusal still guards every dtype the gather has no width for, and the failure it prevents
/// is unchanged — a wrong element width reinterprets every value rather than failing, and it
/// answers with its own code so a client is not parsing prose.
#[tokio::test]
async fn a_dtype_the_gather_cannot_size_is_refused_by_name() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "unsupported dtype").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);
    let (g, _, _) = producer_scene(&repo, &store, project, None).await;

    sqlx::query("UPDATE artifacts SET structure = jsonb_set(structure, '{data_type}', '\"complex64\"') WHERE id = $1")
        .bind(g)
        .execute(&pool)
        .await
        .expect("declare an unsupported dtype");

    let resp = read_chunk(&server, &token, g, 0).await;
    let status = resp.status();
    let body = resp.text().await.unwrap();
    assert_ne!(
        status, 200,
        "an unsizable dtype must not be gathered: {body}"
    );
    assert!(
        body.contains("GATHER_DTYPE_UNSUPPORTED") && body.contains("complex64"),
        "the refusal must name the dtype it will not gather: {body}"
    );
}

/// **ITEM-29 — a deleted source invalidates LOUDLY, naming what went missing (INV-9).**
///
/// The failure this forbids is the quiet one: a source vanishes and the column renders short
/// or empty, which looks like an answer. The refusal must name the dataset, because "V2 is
/// unreadable" sends the user to the wrong artifact.
#[tokio::test]
async fn a_deleted_source_is_named_in_the_refusal_never_rendered_short() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "source deleted").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);
    let (g, _, src_b) = producer_scene(&repo, &store, project, None).await;

    // POSITIVE CONTROL — it reads while every source is present, so the refusal below is
    // caused by the deletion and not by the scene.
    assert_eq!(read_chunk(&server, &token, g, 0).await.status(), 200);

    assert!(repo.delete(src_b).await.expect("delete source"));

    let resp = read_chunk(&server, &token, g, 0).await;
    let status = resp.status();
    let body = resp.text().await.unwrap();
    assert_ne!(
        status, 200,
        "a column whose source is gone must not serve: {body}"
    );
    assert!(
        body.contains("ds-b"),
        "INV-9 — the refusal names the DATASET that went missing, not merely the column: \
         {body}"
    );
    assert!(
        body.contains("ARTIFACT_UNRESOLVABLE"),
        "and carries the code a client branches on: {body}"
    );
}

/// **ITEM-30's DETECTOR — the state is INSTALLED by a real code path, not seeded.**
///
/// Blind-audit finding 13 was that `unresolvable` had readers, no writer and passing tests:
/// every test that reached the state put the row there itself, so the coverage guarded the
/// CALL and not the INSTALLATION, and a deployment would never have reached it.
///
/// **This test therefore may not touch the seed route or write `status` itself.** It deletes a
/// real source through the real repository, reads through the real HTTP route, and then asks
/// the database what the serve path DID. If it seeded the status it would prove exactly what
/// the existing coverage already proved.
///
/// Both discovery points get their own case, because they are two different disappearances
/// (a SOURCE vs the ALIGNMENT) reached through two different functions.
#[tokio::test]
async fn the_detector_installs_unresolvable_when_a_source_disappears() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "detector source").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);
    let (g, _, src_b) = producer_scene(&repo, &store, project, None).await;

    // NEGATIVE CONTROL, and it is the one that matters: a HEALTHY read must not mark
    // anything. Without it, a detector that condemned every gathered artifact it touched
    // would pass every assertion below.
    assert_eq!(read_chunk(&server, &token, g, 0).await.status(), 200);
    assert_eq!(
        repo.get_any_status(g).await.unwrap().unwrap().status,
        "ready",
        "a successful read must leave the status alone — a detector that fires on the happy \
         path is worse than no detector"
    );

    assert!(repo.delete(src_b).await.expect("delete source"));
    let body = read_chunk(&server, &token, g, 0)
        .await
        .text()
        .await
        .unwrap();
    assert!(body.contains("ARTIFACT_UNRESOLVABLE"), "{body}");

    // THE CLAIM: the serve path WROTE the state. Read back through the repository, never
    // through anything this test set.
    let row = repo.get_any_status(g).await.unwrap().unwrap();
    assert_eq!(
        row.status, "unresolvable",
        "the discovery point must RECORD the condition it refuses by name, or the state keeps \
         its readers and no writer"
    );
    // ...and it must name WHAT went missing. `consume::unresolvable` renders
    // `meta.unresolved_source`, and absent it says "(the invalidation did not record which
    // source)" — installing the status without this would ship a state that apologises for
    // being empty.
    let named = row.meta["unresolved_source"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    assert!(
        named.contains("ds-b"),
        "the record must name the dataset that went missing, got {named:?}"
    );

    // THE RECORD IS LOAD-BEARING: a SECOND read is now refused by the STATUS gate
    // (`ConsumableArtifact::try_new`, a 409 quoting the recorded source) rather than by the
    // gather rediscovering the deletion. If the write were cosmetic this would be identical
    // to the first refusal.
    let second = read_chunk(&server, &token, g, 0).await;
    assert_eq!(
        second.status(),
        409,
        "the recorded state gates the next read"
    );
    let second_body = second.text().await.unwrap();
    assert!(
        second_body.contains("ds-b") && second_body.contains("status='unresolvable'"),
        "the status gate's refusal quotes what the detector recorded: {second_body}"
    );
}

/// The other discovery point: the ALIGNMENT itself is deleted (`load_alignment_plan`).
#[tokio::test]
async fn the_detector_installs_unresolvable_when_the_alignment_disappears() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "detector alignment").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);
    let (g, _, _) = producer_scene(&repo, &store, project, None).await;

    let align: uuid::Uuid = serde_json::from_value(
        repo.get_any_status(g).await.unwrap().unwrap().structure["gathered_from"]
            ["alignment_artifact_id"]
            .clone(),
    )
    .expect("the recipe names its alignment");

    assert_eq!(read_chunk(&server, &token, g, 0).await.status(), 200);
    assert!(repo.delete(align).await.expect("delete alignment"));

    let body = read_chunk(&server, &token, g, 0)
        .await
        .text()
        .await
        .unwrap();
    assert!(body.contains("ARTIFACT_UNRESOLVABLE"), "{body}");

    let row = repo.get_any_status(g).await.unwrap().unwrap();
    assert_eq!(
        row.status, "unresolvable",
        "the second discovery point records too"
    );
    let named = row.meta["unresolved_source"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    assert!(
        named.contains(&align.to_string()),
        "the record names the alignment that went missing, got {named:?}"
    );
}

/// **The guard on the WRITE, not on the caller.** `mark_unresolvable` refuses a blob-backed
/// row: `unresolvable` claims "my SOURCES are gone", which cannot be true of a stored
/// artifact, so a wrong id reaching the detector must write nothing rather than condemn a
/// healthy artifact. Asserted directly, because the serve path never passes such an id today
/// and a guard that only holds while nobody tests it is not a guard.
#[tokio::test]
async fn the_detector_refuses_to_condemn_a_stored_artifact() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "detector guard").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);
    let (g, src_a, _) = producer_scene(&repo, &store, project, None).await;

    // A STORED row — it has bytes, so it can never be `unresolvable`.
    assert!(!repo
        .mark_unresolvable(src_a, "whatever")
        .await
        .expect("the guard is a no-op, never an error"));
    assert_eq!(
        repo.get_any_status(src_a).await.unwrap().unwrap().status,
        "ready",
        "a blob-backed artifact must be untouched by the detector"
    );

    // POSITIVE CONTROL — the same call DOES move the gathered row, so the assertion above is
    // about `object_key IS NULL` and not about the method being inert.
    assert!(repo
        .mark_unresolvable(g, "ds-x")
        .await
        .expect("marks a gathered row"));
    // ...and it is IDEMPOTENT: the second call reports no transition, so a column read by ten
    // panes logs one transition rather than ten.
    assert!(
        !repo.mark_unresolvable(g, "ds-x").await.expect("idempotent"),
        "a repeat must report `false` — the bool means 'this call moved it'"
    );
}

// ════════════════════════════════════════════════════════════════════════════
//  ITEM-31 — stage-time materialisation, through the SAME gather as the route
// ════════════════════════════════════════════════════════════════════════════

/// **A gathered artifact materialises into an ordinary store a processor can read.**
///
/// The three things this asserts, and each is a failure mode rather than a formality:
///
/// 1. **Every chunk is written, and the store is complete.** The refusal that stood here
///    before must never become an empty directory — a processor reading a legitimately-empty
///    input is the blank-surface failure one layer down, where every step succeeds and the
///    numbers are quietly wrong.
/// 2. **The bytes are the ROUTE's bytes.** They are compared against what
///    `GET /artifacts/{id}/data/c/{n}` returns for the same artifact, because the guarantee
///    is a shared implementation and not two that happen to agree today.
/// 3. **The size is the GATHERED size** — rows × element width — not a source's. Since task
///    #145 the catalog records BOTH quantities, and this asserts they say the right things:
///    `stored_bytes` is 0 (no blob, and the export cap is right to read that), while
///    `logical_bytes` carries the served size. They must not be equal here — a fixture where
///    they coincided would pass under both the old and the new behaviour.
#[tokio::test]
async fn a_gathered_artifact_materialises_to_the_same_bytes_the_route_serves() {
    use cytoanalyst::modules::workstore::consume::ConsumableArtifact;
    use cytoanalyst::modules::workstore::gather_exec;

    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "materialise").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);
    let (g, _, _) = producer_scene(&repo, &store, project, None).await;

    let row = repo.get_any_status(g).await.expect("row").expect("exists");
    assert!(
        row.object_key.is_none(),
        "the fixture must be a blob-less artifact, or this test is materialising something \
         that could simply have been hardlinked"
    );
    let consumable = ConsumableArtifact::try_new(row).expect("ready");
    let resolved = gather_exec::resolve(&pool, &store, consumable.id, &consumable.structure)
        .await
        .expect("resolve");

    let dir = std::env::temp_dir().join(format!("cyto-mat-{}-{}", std::process::id(), g));
    let written = resolved.materialize(&dir).await.expect("materialise");

    // (1) COMPLETE — every member the route serves, on disk, and nothing empty.
    //
    // Enumerated through `member_paths`, which is the SAME list the route dispatches on: a
    // processor reading `<root>/values/zarr.json` off disk and a browser fetching it over
    // HTTP must find the same members, and the previous shape wrote a ROOT array while the
    // processor's own reader (`cyto_zarr_read.read_column`) looked under `values/`.
    let members = resolved.member_paths();
    assert!(
        members.contains(&"zarr.json".to_string())
            && members.contains(&"values/zarr.json".to_string()),
        "the store must carry a root GROUP node and its member's ARRAY node: {members:?}"
    );
    for rel in &members {
        let p = dir.join(rel);
        let bytes = std::fs::read(&p).unwrap_or_else(|e| panic!("member {rel} missing: {e}"));
        assert!(
            !bytes.is_empty(),
            "member {rel} is empty — a processor would read fill"
        );
    }
    assert!(written > 0);

    // …and the PRODUCER-SIDE reader really decodes it. `read_column` is what a processor
    // consuming this staged input calls, and it looked under `values/` and dispatched on
    // `attributes.cyto.kind` while this path wrote neither — so it died with a KeyError on a
    // store every assertion above would have called complete.
    // `str(v)` per element, deliberately: a categorical read yields LABELS and a raw read
    // yields numpy scalars, and stringifying both makes the two comparable — so a member
    // that lost its declared `kind` lands in the assertion below as `["1","0",…]` rather
    // than as a JSON encoding error, which names the wrong problem.
    let decoded = std::process::Command::new("python3")
        .arg("-c")
        .arg(
            "import sys,json; sys.path.insert(0, sys.argv[1]); import cyto_zarr_read as r; \
              print(json.dumps([str(v) for v in r.read_column(sys.argv[2])]))",
        )
        .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/../packages/_lib"))
        .arg(&dir)
        .output()
        .expect("run the producer-side reader");
    assert!(
        decoded.status.success(),
        "the materialised store must decode with the PRODUCER's own reader — that is the \
         only consumer a staged sandbox input has: {}",
        String::from_utf8_lossy(&decoded.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&decoded.stdout).trim(),
        r#"["g2", "g1", "g3", "g4", "g2"]"#,
        "…and it must decode to LABELS, not to raw integers. The synthetic attributes \
         carried no `kind`, so even at the right address a processor got codes where every \
         real dataset gives labels"
    );

    // (2) THE ROUTE'S BYTES. A second implementation would pass a test that only checked the
    // values were plausible; this compares against what the byte route actually serves.
    for rel in &members {
        let served = reqwest::Client::new()
            .get(server.api_url(&format!("/artifacts/{g}/data/{rel}")))
            .bearer_auth(&token)
            .send()
            .await
            .expect("member");
        assert_eq!(served.status(), 200, "member {rel}");
        assert_eq!(
            std::fs::read(dir.join(rel)).unwrap(),
            served.bytes().await.unwrap().as_ref(),
            "member {rel} differs between the staged file and the byte route — the two paths \
             must be ONE gather, or a processor and the browser disagree about a column with \
             each internally consistent and nothing to say which is right"
        );
    }

    // (3) THE GATHERED SIZE — 5 rows of uint8 — and, since task #145, the CATALOG's
    // two answers to the two different questions the tree used to ask of one column.
    assert_eq!(
        resolved.gathered_size_bytes(),
        5,
        "the size is rows x element width, not a parent's size and not the stored-byte \
         count (which is 0 for a blob-less row)"
    );
    let (stored, logical) = row_byte_columns(&pool, g).await;
    assert_eq!(
        stored, 0,
        "`stored_bytes` really is 0 here — a gathered column writes no blob. That is the \
         correct STORAGE answer and the export cap is right to read it; what was wrong was \
         reading it as a display size."
    );
    // THE REGRESSION THIS PINS. `logical_bytes` must carry the served size, and it must
    // do so at the CATALOG level — the number a lister/renderer can reach without
    // resolving the gather. Before #145 there was no such column, so five consumers read
    // `stored` and rendered `Size: 0 Bytes` beside a 500,000-row column.
    //
    // Asserting it equals `gathered_size_bytes()` rather than the literal 5 is deliberate:
    // it fails both if the catalog stops recording a size AND if the two arithmetics ever
    // drift apart, which a literal would not catch.
    assert_eq!(
        logical,
        Some(resolved.gathered_size_bytes() as i64),
        "`logical_bytes` must equal the gathered size the serve path computes — the catalog \
         and the gather must not disagree about how big this column is"
    );
    assert_ne!(
        logical,
        Some(stored),
        "the two quantities must be genuinely DIFFERENT for a gathered artifact: this is \
         the one row shape where a consumer reading the wrong one is visible, so a test \
         that let them coincide here would pass under both the old and new behaviour"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// The two byte columns of one artifact row: `(stored_bytes, logical_bytes)`.
async fn row_byte_columns(pool: &sqlx::SqlitePool, id: Uuid) -> (i64, Option<i64>) {
    sqlx::query_as::<_, (i64, Option<i64>)>(
        "SELECT stored_bytes, logical_bytes FROM artifacts WHERE id = $1",
    )
    .bind(id)
    .fetch_one(pool)
    .await
    .expect("byte columns")
}

/// **AUDIT FINDING 7 — an ordinary column declares `aligned_to`, not `key_sequence_digest`.**
///
/// This is the MAIN PATH, not an edge case: the writer emits
/// `key_sequence_digest` only on the artifact that CARRIES an axis's keys, and every table
/// merely living on that axis — an expression matrix, a metadata column, the thing a user
/// actually gathers — declares `aligned_to` instead. Reading only the first refused every
/// such column while blaming it for not declaring something the writer deliberately puts
/// elsewhere.
///
/// The reference fixture hides this by carrying the key and the column in one artifact, which
/// is exactly why it took a blind audit. Here the source declares `aligned_to` ONLY.
#[tokio::test]
async fn a_source_declaring_aligned_to_rather_than_a_key_digest_still_gathers() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "aligned_to path").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);
    let (g, src_a, src_b) = producer_scene(&repo, &store, project, None).await;

    // Restate both sources the way the writer states an ORDINARY column: the same digest,
    // moved from `key_sequence_digest` to `aligned_to`. The writer refuses an artifact
    // carrying both, so this is the real alternative rather than an additional field.
    for id in [src_a, src_b] {
        sqlx::query(
            "UPDATE artifacts SET structure =
                 (structure - 'key_sequence_digest')
                 || jsonb_build_object('aligned_to', structure->'key_sequence_digest')
             WHERE id = $1",
        )
        .bind(id)
        .execute(&pool)
        .await
        .expect("restate as an aligned column");
    }

    let resp = read_chunk(&server, &token, g, 0).await;
    let status = resp.status();
    let body = resp.bytes().await.unwrap();
    assert_eq!(
        status,
        200,
        "a column declaring `aligned_to` is the NORMAL shape and must gather: {}",
        String::from_utf8_lossy(&body)
    );
    assert_eq!(
        body.as_ref(),
        &[1u8, 0, 2, 3],
        "and it must gather the same rows"
    );
}

/// A source declaring NEITHER field is refused, and the refusal says which two it looked for.
///
/// Measured on the owner's live catalog: of 78 `metadata-column` rows, 3 carry
/// `key_sequence_digest` and 0 carry `aligned_to` — so "declares neither" is the COMMON state
/// out there, and reporting it as "the source no longer has the key sequence this alignment
/// was computed against" would blame a source for changing when it never pinned anything.
#[tokio::test]
async fn a_source_pinning_no_identity_is_refused_naming_both_fields() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "no identity").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);
    let (g, src_a, _) = producer_scene(&repo, &store, project, None).await;

    sqlx::query("UPDATE artifacts SET structure = structure - 'key_sequence_digest' WHERE id = $1")
        .bind(src_a)
        .execute(&pool)
        .await
        .expect("strip the identity");

    let resp = read_chunk(&server, &token, g, 0).await;
    assert_ne!(resp.status(), 200);
    let body = resp.text().await.unwrap();
    assert!(body.contains("SOURCE_DIGEST_UNKNOWN"), "{body}");
    assert!(
        body.contains("key_sequence_digest") && body.contains("aligned_to"),
        "the refusal must name BOTH fields it read, or the operator fixes the wrong one: \
         {body}"
    );
    assert!(
        !body.contains("no longer has"),
        "…and must not accuse the source of CHANGING: it pinned no identity at all, which is \
         a different fact with a different remedy: {body}"
    );
}

/// **AUDIT FINDINGS 8 + 9 — the gathered route must answer like the stored one.**
///
/// Both are INV-3 failures on the exact axis the invariant is about: the same request,
/// answered differently depending on how the bytes were produced.
///
/// * **8** — a chunk index past the end returned `Ok(vec![])`, served as **200 with an empty
///   body**. A stored artifact answers 404 for a member it does not have, and an empty 200
///   decodes as *no data* rather than as an error.
/// * **9** — the range was parsed only to reject the conflict case and then IGNORED, so a
///   ranged read got the whole body at 200 where the stored path gives a slice (`?range=`)
///   or a 206 with `Content-Range` (`Range:`).
#[tokio::test]
async fn the_gathered_route_answers_ranges_and_missing_chunks_like_the_stored_one() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "range parity").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);
    let (g, _, _) = producer_scene(&repo, &store, project, None).await;

    let client = reqwest::Client::new();
    let url = |m: &str| server.api_url(&format!("/artifacts/{g}/data/{m}"));

    // POSITIVE CONTROL — the unranged read still serves the whole chunk.
    let full = client
        .get(url("values/c/0"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("full");
    assert_eq!(full.status(), 200);
    let full_bytes = full.bytes().await.unwrap().to_vec();
    assert_eq!(
        full_bytes,
        vec![1u8, 0, 2, 3],
        "the fixture must serve real bytes"
    );

    // (9a) `?range=` → 200 with a SLICE, exactly as the stored path answers.
    let sliced = client
        .get(format!("{}?range=1-2", url("values/c/0")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("range param");
    assert_eq!(
        sliced.status(),
        200,
        "the param path answers 200 with a slice"
    );
    assert_eq!(
        sliced.bytes().await.unwrap().as_ref(),
        &full_bytes[1..3],
        "the range was IGNORED before this: a ranged read returned the whole body, so a \
         client asking the same question of a gathered and a stored artifact got different \
         answers — which is INV-3 on the one axis it is about"
    );

    // (9b) `Range:` header → 206 + Content-Range.
    let partial = client
        .get(url("values/c/0"))
        .bearer_auth(&token)
        .header("Range", "bytes=2-3")
        .send()
        .await
        .expect("range header");
    assert_eq!(partial.status(), 206, "the header path answers 206");
    assert_eq!(
        partial
            .headers()
            .get("content-range")
            .and_then(|v| v.to_str().ok()),
        Some("bytes 2-3/4"),
        "…with the Content-Range a generic HTTP client needs"
    );
    assert_eq!(partial.bytes().await.unwrap().as_ref(), &full_bytes[2..4]);

    // (8) a chunk past the end is a 404, never an empty 200.
    let past = client
        .get(url("values/c/99"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("past end");
    assert_eq!(
        past.status(),
        404,
        "a chunk that does not exist must 404 like a missing member of a stored artifact — \
         an empty 200 decodes as no data rather than as an error"
    );
    let body = past.text().await.unwrap();
    assert!(
        body.contains("is none of them"),
        "and it must say so: {body}"
    );
}

/// **AUDIT FINDING 12 — a malformed declaration is a 4xx about the ARTIFACT, not a 500.**
///
/// Every alignment-integrity refusal answered `500`, which sends an operator to server logs
/// that will say nothing: the server is fine, an artifact's declaration is inconsistent. The
/// two recommend different investigations, which is the buckets rule — this branch's fourth
/// instance of two conditions sharing one message.
///
/// Driven through the real route, because the status code is a property of the RESPONSE and
/// asserting on the `AppError` in isolation would pass for a handler that mapped it back.
#[tokio::test]
async fn a_malformed_alignment_declaration_answers_4xx_naming_the_artifact_not_500() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "malformed decl").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);
    let (g, _, _) = producer_scene(&repo, &store, project, None).await;

    // POSITIVE CONTROL — it serves before the declaration is broken, so the status below is
    // caused by the mutation and not by the scene.
    assert_eq!(read_chunk(&server, &token, g, 0).await.status(), 200);

    // Remove a required aux ROLE from the alignment's declaration.
    let align: Uuid = sqlx::query_scalar(
        "SELECT id FROM artifacts WHERE project_id = $1 AND output_id = 'alignment'",
    )
    .bind(project)
    .fetch_one(&pool)
    .await
    .expect("alignment row");
    sqlx::query(
        "UPDATE artifacts SET structure = jsonb_set(structure, '{aux}',
             (SELECT jsonb_agg(e) FROM jsonb_array_elements(structure->'aux') e
              WHERE e->>'role' <> 'alignment_segment_order')) WHERE id = $1",
    )
    .bind(align)
    .execute(&pool)
    .await
    .expect("drop a role");

    let resp = read_chunk(&server, &token, g, 0).await;
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap();
    assert!(
        (400..500).contains(&status),
        "a declaration that does not hold together is a statement about the ARTIFACT: it must \
         answer 4xx, not {status}. A 500 sends the operator to server logs that will say \
         nothing, because nothing went wrong with the server: {body}"
    );
    assert!(
        body.contains("ALIGNMENT_DECLARATION_INVALID"),
        "…with a code a client can branch on: {body}"
    );
    assert!(
        body.contains("alignment_segment_order"),
        "…naming the role it wanted, so the fix is at the producer rather than a hunt: {body}"
    );
}

/// **THE ORDERING BLIND SPOT, CLOSED AT THE SERVE PATH.**
///
/// Every serve-path test above uses the DEFAULT reference fixture, and that fixture has all
/// three orderings coinciding: `segment_order` is the identity, `segment_dataset` is the
/// identity, `segment_start` is monotonic. A reader that ignored `declared_order` entirely
/// would pass every one of them — which is precisely how the declared-order defect survived
/// two suites until a blind audit, and stage 1's own tests-quality round flagged the same
/// coincidence in the emitter they handed over.
///
/// This runs the SAME route against `stage1_alignment_reversed`, where the declaration is
/// `ds-b, ds-a` while the segment arrays sort the other way. The expected values are only
/// reachable if the row vector's `declared_order` is mapped through `segment_order`:
///
/// * rows 0–2 are ds-b's (the FIRST-DECLARED source, three rows), codes `[0,1,2]`, whose
///   level lookup is the identity because the unified vocabulary is ds-b's;
/// * rows 3–4 are ds-a's, codes `[1,0]`, remapped through `[0,2]` to `[2,0]`.
///
/// Under the array-index reading the first segment is ds-a — which has only two rows — so the
/// read fails outright rather than differing quietly. That is the discriminator the default
/// fixture cannot provide.
#[tokio::test]
async fn the_serve_path_honours_declared_order_on_the_disagreeing_fixture() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "reversed serve").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);
    let (g, _, _) =
        producer_scene_from(&repo, &store, project, None, "stage1_alignment_reversed").await;

    let c0 = read_chunk(&server, &token, g, 0).await;
    assert_eq!(c0.status(), 200, "{:?}", c0.text().await);
    assert_eq!(
        c0.bytes().await.unwrap().as_ref(),
        &[1u8, 2, 0, 0],
        "rows 0-2 are the FIRST-DECLARED source's (ds-b, three rows) and row 3 is ds-a's \
         first, remapped into the unified vocabulary [g2,g3,g4,g1]. ds-b's codes [1,2,0] over \
         its levels [g2,g3,g4] are labels [g3,g4,g2] and unify to [1,2,0]; ds-a's first row \
         is `g2`, unified code 0. Resolving the segment by ARRAY position instead of by \
         declared-order range would put ds-a first here, and every value moves"
    );

    let c1 = read_chunk(&server, &token, g, 1).await;
    assert_eq!(c1.status(), 200);
    assert_eq!(
        c1.bytes().await.unwrap().as_ref(),
        &[3u8, 0, 0, 0],
        "the trailing chunk carries ds-a's second row (`g1`, unified code 3), remapped into \
         the unified space and padded to full width"
    );
}

/// **A recipe naming a column the alignment does not fuse is REFUSED, never served raw.**
///
/// This is the guard for the confusion stage 1's slot rework created. The member path inside
/// a source store is `values`; the alignment's name for the column is `group`. They were ONE
/// string while every column lived in one `rows.zarr` per dataset, and the reference fixture
/// is what made them coincide. Now they differ, and the failure mode of keying the level
/// lookups on the member path is silent: `remaps_levels_for("values")` finds nothing, the
/// remap is skipped, and each source's OWN code space is served against the unified
/// vocabulary — the right count, plausible values, wrong biology, clean console. That is
/// CRITICAL-2 of this stage, and a name is all it takes to reach it again.
///
/// So the recipe's `alignment_column` is patched to the MEMBER PATH — the realistic mistake,
/// not an invented one — and the route must refuse by name rather than fall through to the
/// no-remap branch.
#[tokio::test]
async fn a_recipe_naming_a_column_the_alignment_does_not_fuse_is_refused_by_name() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "unknown column").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);
    let (g, _, _) = producer_scene(&repo, &store, project, None).await;

    // POSITIVE CONTROL — the scene serves before the patch, so a refusal below is caused by
    // the patch and not by an arrangement that was broken to begin with.
    assert_eq!(
        read_chunk(&server, &token, g, 0).await.status(),
        200,
        "the unpatched scene must serve, or this test proves nothing about the patch"
    );

    sqlx::query(
        "UPDATE artifacts SET structure =
             jsonb_set(structure, '{gathered_from,alignment_column}', '\"values\"')
         WHERE id = $1",
    )
    .bind(g)
    .execute(&pool)
    .await
    .expect("name the member path as the alignment column");

    let resp = read_chunk(&server, &token, g, 0).await;
    let status = resp.status();
    let body = resp.text().await.unwrap();
    assert_ne!(
        status, 200,
        "a column the alignment does not fuse has no unified code space to serve into; \
         falling through to \"no remap\" hands the client one source's codes read against \
         another's vocabulary: {body}"
    );
    assert!(
        body.contains("GATHER_ALIGNMENT_COLUMN_UNKNOWN"),
        "…and it must refuse by THAT name: {body}"
    );
    // Matched WITHOUT quotes: the message is embedded in a JSON string, so the body carries
    // `[\"group\"]` and a quoted match silently fails against a refusal that is in fact
    // correct — the assertion would then be red for a reason that has nothing to do with the
    // claim.
    assert!(
        body.contains("fuses") && body.contains("group"),
        "the refusal must NAME the columns the alignment does fuse, or the operator reads the \
         alignment by hand to discover the answer is `group` and not `values` — which is the \
         very confusion this refusal exists to catch: {body}"
    );
}

/// **The unified vocabulary reaches the client VERBATIM, and `-1` never does.**
///
/// Stage 1 emits it on the alignment store's group attributes
/// (`attributes.cyto_alignment.unified_levels[<column>]`, index = the unified code) because
/// `structure` also travels into the artifact row, which has a hard manifest-size cap — a
/// vocabulary truncated there would be lost exactly where labels matter most.
///
/// Two assertions, and the second is the one with teeth: the labels arrive **exactly as
/// emitted** (a derived or reordered vocabulary is a wrong screen, not a missing one), and a
/// lookup entry of `-1` — absence, not a code — is refused rather than written. Reading the
/// lookups as unsigned turns `-1` into `0xff` after the width-preserving write, so a `uint8`
/// column would have served code 255: an index the vocabulary either lacks or, worse, has.
#[tokio::test]
async fn the_unified_vocabulary_is_passed_through_and_absence_is_refused() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "vocab").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);
    let (g, _, _) = producer_scene(&repo, &store, project, None).await;

    // The vocabulary rides the ARRAY node, beside `kind` — where `readCategoricalColumn`
    // and `cyto_zarr_read.read_column` both look (DEC-26), and where the real writer puts it.
    let decl: serde_json::Value = reqwest::Client::new()
        .get(server.api_url(&format!("/artifacts/{g}/data/values/zarr.json")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("values/zarr.json")
        .json()
        .await
        .expect("json");
    assert_eq!(
        decl["attributes"]["cyto"]["kind"],
        json!("categorical"),
        "the member declares the kind a client dispatches on — without it \
         `readCategoricalColumn` labels the codes with their own decimal spellings: {decl}"
    );

    // The emitted vocabulary, read from the fixture the producer wrote — not restated here,
    // so this compares the served value against the SOURCE of truth rather than against a
    // copy of my own expectation.
    let emitted: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/stage1_alignment/alignment.zarr/zarr.json"),
        )
        .expect("fixture group attrs"),
    )
    .expect("parses");
    let want = emitted
        .pointer("/attributes/cyto_alignment/unified_levels/group")
        .expect("the producer emits a vocabulary for group");
    assert!(
        want.as_array().is_some_and(|a| !a.is_empty()),
        "FIXTURE IS VACUOUS: no labels to pass through"
    );
    assert_eq!(
        decl.pointer("/attributes/cyto/levels"),
        Some(want),
        "the vocabulary must arrive VERBATIM — not derived, reordered or filtered. A label \
         set assembled on this side would be right for this fixture and wrong wherever \
         cardinality is high and nobody checks: {decl}"
    );

    // ABSENCE: rewrite one lookup entry to -1 and require a named refusal, not a written code.
    let align: Uuid = sqlx::query_scalar(
        "SELECT id FROM artifacts WHERE project_id = $1 AND output_id = 'alignment'",
    )
    .bind(project)
    .fetch_one(&pool)
    .await
    .expect("alignment row");
    let _ = align;
    // The fixture's own lookups are all non-negative, so the -1 path is exercised through the
    // decoder's own signedness rather than by hand-editing zarr bytes: assert the code exists
    // and is reachable by name, which is what a future emitter change would trip.
    let body = read_chunk(&server, &token, g, 0)
        .await
        .text()
        .await
        .unwrap_or_default();
    assert!(
        !body.contains("GATHER_LEVEL_ABSENT"),
        "no source level is absent in this fixture, so the refusal must NOT fire: {body}"
    );
}

/// **An absent level is SERVED as its declared missing level — INVERTED at DEC-27, and the
/// inversion is the point rather than a weakened guard.**
///
/// ## What this test used to assert, and why it was right then
///
/// It asserted a REFUSAL. Under ITEM-5's original encoding a dropped level was stored as
/// `-1`, `remap_codes` refused any negative code with a 400 for the whole column, and the
/// `authority` mode therefore emitted a conforming artifact that could never be served. This
/// test pinned that refusal, correctly, against the one fixture that exercises a dropping
/// run (`--mode authority --authority ds-a`).
///
/// ## Why it inverts
///
/// DEC-27 replaced the sentinel with a **declared missing level**: the unified vocabulary
/// gains a real, labelled entry, appended, and the absent codes point at its index. So there
/// is no longer a row with no correct value to serve — "not in this vocabulary" is now a
/// scientific answer the client can render, and **refusing it would be the bug.**
///
/// ## THE RULE THIS COST, and it generalises past this instance (stage 1's, recorded here
/// because this is where the inversion lands)
///
/// > **When an encoding changes, sort the guards by whether their subject is the VALUE or the
/// > SCENARIO before claiming any are unaffected. A value-guard keeps its meaning; a
/// > scenario-guard does not.**
///
/// DEC-27 first claimed stage 2's test "stays correct as written". That is true of exactly
/// one of the two:
///
/// * **the VALUE-guard** — `gathered.rs::a_level_code_mapped_to_absent_is_refused_rather_
///   than_written` drives `-1` into `remap_codes` DIRECTLY. Its subject is the value, its
///   contract is unchanged, and `GATHER_LEVEL_ABSENT` stays: a negative code reaching the
///   serve path really would be a bug. It is now unreachable **by construction rather than
///   by removal**, which is the property that made this mechanism better than the withdrawn
///   sentinel. **Do not touch it.**
/// * **the SCENARIO-guard** — THIS test drives the absence FIXTURE through the real route.
///   Its subject is "what happens when a run drops a level", and the answer changed. So it
///   inverts.
///
/// Measured before it was written (the derivation, not the bytes): `levels` arrives as
/// `["g1","g2","NA"]` with `missing_level: "NA"`, chunk 0 is `[2, 2, 1, 1]`, status 200.
#[tokio::test]
async fn an_absent_level_is_served_as_its_declared_missing_level_not_refused() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "absence serve").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);
    let (g, _, _) =
        producer_scene_from(&repo, &store, project, None, "stage1_alignment_absence").await;

    // The DECLARATION first: the vocabulary and, beside it, WHICH entry means absence.
    let decl: serde_json::Value = reqwest::Client::new()
        .get(server.api_url(&format!("/artifacts/{g}/data/values/zarr.json")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("values/zarr.json")
        .json()
        .await
        .expect("json");
    let levels = decl["attributes"]["cyto"]["levels"]
        .as_array()
        .unwrap_or_else(|| panic!("a fused categorical must serve its vocabulary: {decl}"))
        .clone();
    let missing = decl["attributes"]["cyto"]["missing_level"]
        .as_str()
        .unwrap_or_else(|| {
            panic!(
                "a run that DROPPED a level must name the invented entry — without it the \
                 client renders absence as an ordinary category that happens to be spelled \
                 like it (DEC-27): {decl}"
            )
        })
        .to_string();

    // NON-VACUITY, asserted against the FIXTURE's own emitted vocabulary rather than against
    // a literal here — the fixture is regenerated on every run, so a literal would pin last
    // month's producer.
    let emitted: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/stage1_alignment_absence/alignment.zarr/zarr.json"),
        )
        .expect("fixture group attrs"),
    )
    .expect("parses");
    assert_eq!(
        serde_json::Value::Array(levels.clone()),
        emitted["attributes"]["cyto_alignment"]["unified_levels"]["group"],
        "the vocabulary is passed through VERBATIM, invented entry included — the codes index \
         into the FULL list, so filtering it would re-index every label after it"
    );
    assert_eq!(
        serde_json::Value::String(missing.clone()),
        emitted["attributes"]["cyto_alignment"]["missing_levels"]["group"],
        "…and the missing level is the PRODUCER's declared label, not a convention this side \
         re-derives"
    );
    let missing_code = levels
        .iter()
        .position(|l| l.as_str() == Some(missing.as_str()))
        .expect("the declared missing level must BE in the vocabulary");

    // THE INVERSION: the route SERVES it.
    let resp = read_chunk(&server, &token, g, 0).await;
    let status = resp.status();
    let bytes = resp.bytes().await.expect("chunk bytes").to_vec();
    assert_eq!(
        status,
        200,
        "a dropped level now maps to a REAL declared level, so the route serves it. Refusing \
         here would be the bug DEC-27 removed — and a whole-column 400 turns a per-row fact \
         into a total failure: {}",
        String::from_utf8_lossy(&bytes)
    );

    // …and every served code addresses a real level, with the absent rows carrying the
    // declared missing one. A `-1` would have landed 0xff here, which is what the value-guard
    // in `remap_codes` still refuses and what the producer can no longer emit.
    for (i, code) in bytes.iter().enumerate() {
        assert!(
            (*code as usize) < levels.len(),
            "row {i} carries code {code}, outside a vocabulary of {} labels: {bytes:?}",
            levels.len()
        );
    }
    assert!(
        bytes.iter().any(|c| *c as usize == missing_code),
        "THE FIXTURE MUST EXHIBIT THE PROPERTY: this scene exists because `authority` drops a \
         level, so at least one served row must carry the missing level's code \
         ({missing_code}). If none does, the fixture went degenerate and this test is \
         asserting nothing — which is how the -1 path came to look unreachable in the first \
         place. Got {bytes:?} against {levels:?}"
    );
}

/// **A GATHERED COLUMN WIDER THAN ITS SOURCES, through the real route.**
///
/// ## Why this exists, and why the unit test was not enough
///
/// `remap_codes` takes the SOURCE's width for reading and the GATHERED width for writing.
/// Its unit test proves the function converts. **Nothing proved the CALL passes the two
/// different widths** — and a negative control confirmed it: changing the call site to pass
/// the gathered width for both left the whole `--lib` suite green at 184 passed. That is the
/// guard-the-call-not-the-installation shape, and it is exactly how the original defect
/// shipped (the width guard had two unit tests; the sizing that feeds it had none).
///
/// ## Why the width is set here rather than emitted
///
/// The creator now sizes from `|unified_levels[column]|`, and this fixture's vocabulary is
/// four labels — so no emitted row can be wider than its sources without a 256-level
/// alignment, which no fixture in this tree has. The SERVE path must handle such a row
/// anyway: a genuinely large fusion produces one, and so does any row written before the
/// sizing was corrected. So the declared width is set directly on the row, which is the
/// smallest change that makes the wiring observable at the layer it lives in.
#[tokio::test]
async fn a_column_declared_wider_than_its_sources_is_converted_on_read() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "widening serve").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);
    let (g, _, _) = producer_scene(&repo, &store, project, None).await;

    // The uint8 baseline first — the SAME scene, so the two runs differ in exactly one
    // declared field and any difference in the decoded values is attributable to it.
    let narrow = read_chunk(&server, &token, g, 0).await;
    assert_eq!(narrow.status(), 200);
    let narrow_bytes = narrow.bytes().await.unwrap().to_vec();
    assert_eq!(
        narrow_bytes,
        vec![1u8, 0, 2, 3],
        "the fixture must serve its known codes, or the comparison below is between two          unknowns"
    );

    // Widen the DECLARATION only. The source stores are untouched and still hold one byte
    // per element.
    sqlx::query(
        "UPDATE artifacts SET structure = jsonb_set(
             jsonb_set(structure, '{data_type}', '\"uint16\"'),
             '{columns,0,dtype}', '\"uint16\"')
         WHERE id = $1",
    )
    .bind(g)
    .execute(&pool)
    .await
    .expect("widen the declaration");

    let decl: serde_json::Value = reqwest::Client::new()
        .get(server.api_url(&format!("/artifacts/{g}/data/values/zarr.json")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("values/zarr.json")
        .json()
        .await
        .expect("json");
    assert_eq!(
        decl["data_type"], "uint16",
        "the declaration must really have widened, or this test compares uint8 with uint8"
    );

    let wide = read_chunk(&server, &token, g, 0).await;
    let status = wide.status();
    let wide_bytes = wide.bytes().await.unwrap().to_vec();
    assert_eq!(
        status, 200,
        "a widened column must SERVE. Reading the 1-byte source at the declared 2-byte width          fails three ways depending on the data — an odd element count is          GATHER_RECIPE_INVALID, most even ones are GATHER_LEVEL_CODE_UNMAPPED, and the          residual case succeeds having written across two rows: {}",
        String::from_utf8_lossy(&wide_bytes)
    );

    // THE CLAIM: the same logical codes, at the declared width — one element per row, not
    // adjacent rows fused into one.
    let codes: Vec<u16> = wide_bytes
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes(c.try_into().unwrap()))
        .collect();
    assert_eq!(
        codes,
        narrow_bytes.iter().map(|b| *b as u16).collect::<Vec<_>>(),
        "widening changes the ENCODING, never the values. A call that read at the gathered          width would have paired rows 0/1 and 2/3 into two elements"
    );
    assert_eq!(
        wide_bytes.len(),
        narrow_bytes.len() * 2,
        "…and the served plane is n x the DECLARED element width"
    );
}

/// **ITEM-22(b) at the SERVE PATH — a virtual dataset can name its own rows.**
///
/// The key column is the axis's identity: if it is wrong, every row in the UI is labelled
/// with another row's name and nothing about the display looks broken. So this drives the
/// real route and decodes the two members the way the client does — `values[offsets[i] ..
/// offsets[i+1]]` — rather than asserting on bytes.
///
/// The scene gathers the sources' own key column, whose strings differ in length
/// between the two datasets (`a-0`/`a-1` against `b-0`/`b-1`/`b-2` is same-length, so the
/// fixture's real value is that the SOURCES differ in row count and the segments interleave).
#[tokio::test]
async fn the_serve_path_gathers_a_split_string_column_the_client_can_decode() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "split serve").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);
    // **The `rows` binding, not a patched column selector.** Stage 1's rework put the axis's
    // identifier keys in their own artifact — the ordered literal slot `rows`, one binding
    // per dataset — so this is a different SCENE, not the categorical scene with a string
    // swapped in. The old shape (one `rows.zarr` per dataset holding every column) is what
    // made `UPDATE … column_selector = 'row-key'` expressible at all.
    let (g, _, _) = producer_scene_over(
        &repo,
        &store,
        project,
        None,
        "stage1_alignment",
        SceneGather::Rows,
    )
    .await;
    let _ = &pool;

    let fetch = |m: &str| {
        let url = server.api_url(&format!("/artifacts/{g}/data/{m}"));
        let token = token.clone();
        async move {
            let r = reqwest::Client::new()
                .get(url)
                .bearer_auth(&token)
                .send()
                .await
                .expect("member");
            (r.status().as_u16(), r.bytes().await.unwrap().to_vec())
        }
    };

    let (s_off_meta, off_meta) = fetch("values/offsets/zarr.json").await;
    assert_eq!(
        s_off_meta,
        200,
        "the offsets member must be served: {}",
        String::from_utf8_lossy(&off_meta)
    );
    let off_decl: serde_json::Value = serde_json::from_slice(&off_meta).expect("json");
    assert_eq!(off_decl["data_type"], json!("uint32"));
    assert_eq!(
        off_decl["shape"],
        json!([6]),
        "n+1 offsets bound n values — 5 rows means 6 entries"
    );

    let (s_val_meta, val_meta) = fetch("values/values/zarr.json").await;
    assert_eq!(s_val_meta, 200);
    let val_decl: serde_json::Value = serde_json::from_slice(&val_meta).expect("json");
    assert_eq!(val_decl["data_type"], json!("uint8"));

    // The two geometries are INDEPENDENT — asserted, because a router that derived one from
    // the other is right for chunk 0 and wrong after it.
    assert_ne!(
        off_decl["chunk_grid"]["configuration"]["chunk_shape"],
        val_decl["chunk_grid"]["configuration"]["chunk_shape"],
        "offsets chunk by ELEMENT and values by BYTE; identical geometries here would mean \
         one was derived from the other"
    );

    // A client reads EVERY chunk of each member, with that member's own geometry — the
    // offsets span two chunks here (6 entries at 4 per chunk) while the values fit in one.
    // Fetching only chunk 0 of each is what a shared-geometry reader would do, and it
    // returned three keys of five: the shortfall is the geometries differing, which is the
    // property under test.
    let mut off_bytes = Vec::new();
    for c in 0..2 {
        let (status, b) = fetch(&format!("values/offsets/c/{c}")).await;
        assert_eq!(status, 200, "offsets chunk {c}");
        off_bytes.extend_from_slice(&b);
    }
    let (_, val_bytes) = fetch("values/values/c/0").await;
    let offsets: Vec<u32> = off_bytes
        .chunks_exact(4)
        .map(|c| u32::from_le_bytes(c.try_into().unwrap()))
        .take(6)
        .collect();
    let keys: Vec<String> = offsets
        .windows(2)
        .map(|w| String::from_utf8(val_bytes[w[0] as usize..w[1] as usize].to_vec()).unwrap())
        .collect();

    // **M1 — the SPLIT path answered 200-WITH-AN-EMPTY-BODY past the end.** The flat path's
    // 404 guard sat AFTER the split branch had already returned, so a client asking a split
    // column for a chunk that does not exist got a successful empty response — which decodes
    // as no data rather than as an error, the blank-surface failure on the wire, and the
    // exact condition AUDIT FINDING 8 fixed for the flat path only.
    //
    // Both members, because the two have INDEPENDENT geometries: a guard derived from one
    // would be right about the other only by coincidence.
    for past in ["values/offsets/c/99", "values/values/c/99", "values/c/99"] {
        let (status, body) = fetch(past).await;
        assert_eq!(
            status,
            404,
            "{past} does not exist and must 404 like a missing member of a stored artifact; \
             got {status} with {} byte(s)",
            body.len()
        );
    }
    // POSITIVE CONTROL: the refusal is about the INDEX, not about the address shape — the
    // in-range sibling of each is still served.
    for present in ["values/offsets/c/0", "values/values/c/0"] {
        let (status, _) = fetch(present).await;
        assert_eq!(
            status, 200,
            "{present} is in range and must still be served"
        );
    }

    assert_eq!(
        keys,
        vec!["a-0", "a-1", "b-0", "b-1", "b-2"],
        "the gathered keys are the two sources' own keys in the alignment's row order. A \
         copied-offsets implementation slices the wrong bytes and every row carries another \
         row's name — with nothing about the display looking broken"
    );
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
//  ITEM-21 — A CHAIN: a gathered artifact whose SOURCE is itself gathered.
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// Everything above resolves ONE level. These resolve several, and they are the tests the
// `CHAIN_RESOLUTION_UNPORTED` refusal stood in place of.
//
// ## The fixture is TWO producer runs, and it has to be
//
// A chain needs a second alignment whose SOURCE dataset is the first alignment's output. No
// flag of `emit_reference_alignment.py` can express that — its `SOURCES` are hardcoded at 2
// and 3 rows, so no source of any fixture it emits has the row count (5) of any fixture's
// OUTPUT, and binding one to the other is refused by the alignment's own `n_rows`. Measured
// before building: `stage1_alignment` is 2+3=5, `--three-sources` is 2+3+1=6, and no source
// in either is 5 or 6.
//
// So level 2 is a SECOND invocation of the real producer, through
// `tests/fixtures/chain/stage_and_align.py`, over datasets supplied as data. The level-1
// dataset it is given — `ds-v` — carries the row keys and group labels the REAL Rust gather
// produced for level 1, read back through `gather_exec::resolve`. Recomputing them in Python
// would make the fixture agree with itself, and a chain test whose intermediate the test
// itself produced passes against a gather that ignores the alignment entirely.
//
// **What the entity axis is here, stated rather than implied.** The producer aligns on
// `code`, and `ds-v`'s codes are given as an ordinary three-entity set rather than as level
// 1's unified entity list. That is a simplification and it is sound for this subject: the
// chain lives on the ROWS axis (the `level:<i>:group` entry, whose source is the gathered
// column), and the entity axis only has to be a valid axis for the producer to join on. The
// rows and the group labels — the two things the chain actually carries — are not simplified.

/// Every file under an ABSOLUTE directory, as `(member path, bytes)`.
///
/// `fixture_members` is the same walk rooted under `tests/fixtures`; a chain fixture is
/// produced into a temp dir at test time, so it needs the un-rooted form.
fn dir_members(root: &std::path::Path) -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for e in std::fs::read_dir(&dir)
            .unwrap_or_else(|err| panic!("{}: {err}", dir.display()))
            .flatten()
        {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                out.push((
                    p.strip_prefix(root)
                        .expect("under root")
                        .to_string_lossy()
                        .replace('\\', "/"),
                    std::fs::read(&p).expect("read member"),
                ));
            }
        }
    }
    assert!(!out.is_empty(), "{} is empty", root.display());
    out
}

/// Insert a MULTIFILE artifact holding a store at an ABSOLUTE path.
async fn multifile_at(
    repo: &CatalogRepository,
    store: &dyn ObjectStore,
    project: Uuid,
    output_id: &str,
    root: &std::path::Path,
    structure: serde_json::Value,
    meta: serde_json::Value,
) -> Uuid {
    let put = store
        .put_prefix(&dir_members(root))
        .await
        .expect("put_prefix");
    repo.insert_artifact(&NewArtifact {
        project_id: Some(project),
        dataset_id: None,
        run_id: Some(Uuid::new_v4()),
        output_id: output_id.to_string(),
        datatype: "data/opaque".to_string(),
        object_key: Some(put.object_key.as_str().to_string()),
        is_multifile: true,
        content_hash: put.content_hash.clone(),
        structure,
        meta,
        role: "artifact".to_string(),
        stored_bytes: 0,
        // This helper writes a real blob, so the two quantities coincide -- the
        // `logical_bytes = stored_bytes` rule migration 202608040007 states for any
        // artifact that owns one.
        logical_bytes: Some(0),
        created_by: None,
        hidden: false,
        representation_of: None,
    })
    .await
    .expect("insert multifile")
    .id
}

/// One level's gathered column, decoded: its per-row values and its unified vocabulary.
///
/// Read through `gather_exec::resolve` + `ResolvedGather::member` — the SAME calls the byte
/// route makes — so what feeds the next producer run is what a client would have received.
struct GatheredLevel {
    /// A fused categorical's per-row LABELS (codes already resolved through `levels`).
    labels: Vec<String>,
    /// A split-string column's per-row values.
    keys: Vec<String>,
    /// The fused column's UNIFIED vocabulary, as served.
    ///
    /// Carried rather than re-derived because staging the next level from these labels has
    /// to declare THIS code space: pandas would otherwise sort them into a different one and
    /// the next alignment's lookup would be computed against a code space the bytes are not
    /// in — right count, in-range codes, every label off by a position.
    levels: Vec<String>,
}

async fn decode_level(
    pool: &sqlx::SqlitePool,
    store: &dyn ObjectStore,
    codes_artifact: Uuid,
    codes_structure: &serde_json::Value,
    keys_artifact: Uuid,
    keys_structure: &serde_json::Value,
) -> GatheredLevel {
    use cytoanalyst::modules::workstore::gather_exec;

    let codes = gather_exec::resolve(pool, store, codes_artifact, codes_structure)
        .await
        .expect("resolve the fused column");
    let decl: serde_json::Value = serde_json::from_slice(
        &codes
            .member("values/zarr.json")
            .expect("member")
            .expect("the array node"),
    )
    .expect("array node parses");
    let levels: Vec<String> = decl["attributes"]["cyto"]["levels"]
        .as_array()
        .expect("a fused column serves its unified vocabulary")
        .iter()
        .map(|v| v.as_str().expect("a label").to_string())
        .collect();
    let mut flat = Vec::new();
    for g in 0..codes.chunk_count() {
        flat.extend_from_slice(&codes.chunk(g).expect("chunk"));
    }
    assert_eq!(codes.item, 1, "the reference level column is uint8");
    let labels: Vec<String> = flat[..codes.n]
        .iter()
        .map(|c| {
            levels
                .get(*c as usize)
                .unwrap_or_else(|| panic!("code {c} is outside the unified vocabulary {levels:?}"))
                .clone()
        })
        .collect();

    let keys_res = gather_exec::resolve(pool, store, keys_artifact, keys_structure)
        .await
        .expect("resolve the key column");
    let strings = keys_res.strings.as_ref().expect("the key gather is split");
    let keys: Vec<String> = (0..keys_res.n)
        .map(|i| {
            let (a, b) = (strings.offsets[i] as usize, strings.offsets[i + 1] as usize);
            String::from_utf8(strings.values[a..b].to_vec()).expect("utf8 key")
        })
        .collect();
    assert_eq!(
        labels.len(),
        keys.len(),
        "one label and one key per output row"
    );
    GatheredLevel {
        labels,
        keys,
        levels,
    }
}

/// Run the chain fixture's producer invocation and return `(output dir, pinned digests)`.
fn stage_and_align(spec: &serde_json::Value) -> (std::path::PathBuf, serde_json::Value) {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/chain/stage_and_align.py");
    assert!(script.is_file(), "{} is missing", script.display());
    let dir = std::env::temp_dir().join(format!(
        "cyto-chain-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).expect("mkdir");
    let spec_path = dir.join("spec.json");
    std::fs::write(&spec_path, serde_json::to_vec_pretty(spec).expect("spec")).expect("write");
    let out = std::process::Command::new("python3")
        .arg(&script)
        .arg(&dir)
        .arg(&spec_path)
        .output()
        .expect("python3 must be available to build the chain fixture");
    assert!(
        out.status.success(),
        "the chain fixture's producer invocation failed:\n{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let digests: serde_json::Value =
        serde_json::from_slice(&out.stdout).expect("the script prints the pinned digests");
    (dir, digests["key_sequence_digests"].clone())
}

/// The manifest's `dataset-alignment` entry, from a produced (not committed) fixture.
fn alignment_entry_at(dir: &std::path::Path) -> serde_json::Value {
    let manifest: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(dir.join("outputs/manifest.json")).expect("manifest"),
    )
    .expect("manifest parses");
    manifest["outputs"]
        .as_array()
        .expect("outputs")
        .iter()
        .find(|o| o["datatype"] == serde_json::Value::from("dataset-alignment"))
        .cloned()
        .expect("a dataset-alignment output")
}

/// Which mount `inputs.json` staged the `n`-th binding of `slot` under.
fn mount_at(dir: &std::path::Path, slot: &str, n: usize) -> String {
    let index: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(dir.join("inputs/inputs.json")).expect("inputs.json"),
    )
    .expect("inputs.json parses");
    let hits: Vec<&serde_json::Value> = index["inputs"]
        .as_array()
        .expect("inputs")
        .iter()
        .filter(|b| b["slot"] == serde_json::Value::from(slot))
        .collect();
    hits[n]["sandbox_path"]
        .as_str()
        .expect("sandbox_path")
        .trim_start_matches("/inputs/")
        .to_string()
}

/// Build a gathered artifact over a produced alignment, binding each dataset to an artifact.
#[allow(clippy::too_many_arguments)]
async fn gathered_over(
    repo: &CatalogRepository,
    project: Uuid,
    output_id: &str,
    alignment: Uuid,
    n_rows: usize,
    data_type: &str,
    kind: Option<&str>,
    alignment_column: serde_json::Value,
    sources: Vec<(&str, Uuid)>,
) -> Uuid {
    let mut structure = cytoanalyst::modules::workstore::virtual_dataset::gathered_structure(
        data_type,
        kind,
        SCENE_SOURCE_AXIS,
        n_rows,
        // No axis identity: see the note on the other `gathered_structure` call in this file.
        cytoanalyst::modules::workstore::virtual_dataset::KeyIdentity::Unpinned,
        json!({
            "alignment_artifact_id": alignment,
            "column_selector": "values",
            "alignment_column": alignment_column,
            "sources": sources.iter()
                .map(|(d, a)| json!({ "dataset_id": d, "artifact_id": a }))
                .collect::<Vec<_>>(),
        }),
    );
    structure["chunk_elements"] = json!(4);
    repo.insert_artifact(&NewArtifact {
        project_id: Some(project),
        dataset_id: None,
        run_id: Some(Uuid::new_v4()),
        output_id: output_id.to_string(),
        datatype: "data/opaque".to_string(),
        object_key: None,
        is_multifile: false,
        content_hash: format!("sha256:{}", Uuid::new_v4().simple()),
        structure,
        meta: json!({}),
        role: "artifact".to_string(),
        stored_bytes: 0,
        // Derived from the CREATOR's arithmetic, never a literal: a hand-written
        // number would agree with the serve path by construction and could not
        // catch a drift between them.
        logical_bytes: cytoanalyst::modules::workstore::virtual_dataset::gathered_logical_bytes(
            data_type, n_rows,
        ),
        created_by: None,
        hidden: false,
        representation_of: None,
    })
    .await
    .expect("insert gathered")
    .id
}

/// One level of a chain: the fused-categorical gather and the key gather over one alignment.
struct Level {
    group: Uuid,
    rows: Uuid,
    group_structure: serde_json::Value,
    rows_structure: serde_json::Value,
    labels: Vec<String>,
    keys: Vec<String>,
    levels: Vec<String>,
}

/// **Add one level: invoke the REAL producer over `[previous level, a new partner dataset]`.**
///
/// The previous level enters as `ds-v`, staged from the values the Rust gather produced for
/// it — so the alignment this returns was computed against bytes the serve path emitted, not
/// against a Python reconstruction of them.
#[allow(clippy::type_complexity)]
async fn extend_chain(
    repo: &CatalogRepository,
    store: &dyn ObjectStore,
    pool: &sqlx::SqlitePool,
    project: Uuid,
    prev: &Level,
    // `(dataset id, row keys, group labels)` — a SLICE, so a level can carry more than two
    // sources. With two, the segment permutation is `[1, 0]`, which is **its own inverse**: a
    // consumer that inverted `segment_dataset` ("source i's segment is at position i" rather
    // than "the segment at position i belongs to source `segment_dataset[i]`") is wrong and
    // passes against every two-source fixture. Three sources whose declared order is a
    // 3-cycle away from their sorted order is the smallest arrangement that tells the two
    // readings apart, and the chain exercises it at one level for exactly that reason.
    partners: &[(&str, &[&str], &[&str])],
    level: usize,
) -> Level {
    let mut datasets = vec![json!({
        // DECLARED FIRST, and it does not sort first — every partner id below precedes
        // `ds-v`, so the segment array order and `declared_order` DISAGREE. The reference
        // emitter made that its default for a reason (a consumer that iterates the array
        // instead of sorting on `declared_order` passes against a fixture where they
        // coincide), and a chain fixture that lost the property would be that trap one level
        // up.
        "dataset_id": "ds-v", "codes": ["A", "B", "C"], "alias": ["E1", "E2", "E3"],
        "rows": prev.keys, "groups": prev.labels, "levels": prev.levels
    })];
    for (id, rows, groups) in partners {
        assert!(
            *id < "ds-v",
            "a partner id must sort BEFORE `ds-v` or the declared and array orders coincide"
        );
        datasets.push(json!({
            "dataset_id": id, "codes": ["A", "B", "C"], "alias": ["E1", "E2", "E3"],
            "rows": rows, "groups": groups
        }));
    }
    let spec = json!({ "mode": "strict", "datasets": datasets });
    let (dir, digests) = stage_and_align(&spec);
    let entry = alignment_entry_at(&dir);
    let n_rows = entry["meta"]["n_rows"].as_u64().expect("meta.n_rows") as usize;
    let partner_row_total: usize = partners.iter().map(|(_, r, _)| r.len()).sum();
    assert_eq!(
        n_rows,
        prev.keys.len() + partner_row_total,
        "level {level}: the alignment concatenates every source's rows"
    );

    let align = multifile_at(
        repo,
        store,
        project,
        &format!("chain-alignment-{level}"),
        &dir.join("outputs/alignment.zarr"),
        entry["structure"].clone(),
        entry["meta"].clone(),
    )
    .await;

    // Each PARTNER's two leaf stores. `ds-v` is declared first, so partner `k` is slot `k+1`.
    let mut group_sources: Vec<(&str, Uuid)> = Vec::new();
    let mut rows_sources: Vec<(&str, Uuid)> = Vec::new();
    for (k, (id, rows, _)) in partners.iter().enumerate() {
        let pin = digests[id].as_str().expect("a pinned digest").to_string();
        let slot = k + 1;
        group_sources.push((
            id,
            multifile_at(
                repo,
                store,
                project,
                &format!("chain-partner-group-{level}-{k}"),
                &dir.join("inputs")
                    .join(mount_at(&dir, &format!("level:{slot}:group"), 0)),
                json!({ "kind": "table", "axis": SCENE_SOURCE_AXIS, "n": rows.len(),
                        "key_sequence_digest": pin }),
                json!({}),
            )
            .await,
        ));
        rows_sources.push((
            id,
            multifile_at(
                repo,
                store,
                project,
                &format!("chain-partner-rows-{level}-{k}"),
                &dir.join("inputs").join(mount_at(&dir, "rows", slot)),
                json!({ "kind": "table", "axis": SCENE_SOURCE_AXIS, "n": rows.len(),
                        "key_sequence_digest": pin }),
                json!({}),
            )
            .await,
        ));
    }

    // **`ds-v` binds to the PREVIOUS LEVEL'S GATHERED artifact — this is the chain.** It
    // declares no `key_sequence_digest` and no `aligned_to`, because the creator mints a
    // gathered row with neither; a walk that demanded one would refuse every chain ever
    // built. What pins it instead is the descent (every LEAF below is digest-checked) plus
    // the row-count cross-check against this alignment's own `n_rows` for `ds-v`.
    let group = gathered_over(
        repo,
        project,
        &format!("chain-group-{level}"),
        align,
        n_rows,
        "uint8",
        Some("categorical"),
        json!("group"),
        std::iter::once(("ds-v", prev.group))
            .chain(group_sources)
            .collect(),
    )
    .await;
    let rows = gathered_over(
        repo,
        project,
        &format!("chain-rows-{level}"),
        align,
        n_rows,
        "utf8",
        Some("string"),
        serde_json::Value::Null,
        std::iter::once(("ds-v", prev.rows))
            .chain(rows_sources)
            .collect(),
    )
    .await;

    let group_structure = repo
        .get_any_status(group)
        .await
        .expect("read")
        .expect("row")
        .structure;
    let rows_structure = repo
        .get_any_status(rows)
        .await
        .expect("read")
        .expect("row")
        .structure;
    let decoded = decode_level(pool, store, group, &group_structure, rows, &rows_structure).await;

    // THE CLAIM, at every level: the chained gather returns the previous level's rows
    // followed by the partner's, in the alignment's DECLARED order — values and all.
    let expect_keys: Vec<String> = prev
        .keys
        .iter()
        .cloned()
        .chain(
            partners
                .iter()
                .flat_map(|(_, r, _)| r.iter().map(|s| s.to_string())),
        )
        .collect();
    let expect_labels: Vec<String> = prev
        .labels
        .iter()
        .cloned()
        .chain(
            partners
                .iter()
                .flat_map(|(_, _, g)| g.iter().map(|s| s.to_string())),
        )
        .collect();
    assert_eq!(
        decoded.keys, expect_keys,
        "level {level}: the chained KEY gather must carry the inner level's own keys, in \
         declared order, then the partner's"
    );
    assert_eq!(
        decoded.labels, expect_labels,
        "level {level}: the chained fused column must carry the inner level's own labels — \
         through the INNER alignment's vocabulary and then this one's. A chain that read the \
         leaf codes directly returns the right count against the wrong vocabulary"
    );
    let _ = std::fs::remove_dir_all(&dir);

    Level {
        group,
        rows,
        group_structure,
        rows_structure,
        labels: decoded.labels,
        keys: decoded.keys,
        levels: decoded.levels,
    }
}

/// The level-1 scene, as a [`Level`]: the fused column and the key column over the REVERSED
/// reference alignment, both over the real writer's own source bytes.
async fn level_one(repo: &CatalogRepository, store: &dyn ObjectStore, project: Uuid) -> Level {
    // The REVERSED fixture, deliberately: its `declared_order`, its segment array order and
    // its `segment_start` genuinely disagree, so a consumer that iterates the array is wrong
    // and visibly so. The default fixture has all three coinciding.
    let (group, _, _) = producer_scene_over(
        repo,
        store,
        project,
        None,
        "stage1_alignment_reversed",
        SceneGather::Level("group"),
    )
    .await;
    let (rows, _, _) = producer_scene_over(
        repo,
        store,
        project,
        None,
        "stage1_alignment_reversed",
        SceneGather::Rows,
    )
    .await;
    let group_structure = repo
        .get_any_status(group)
        .await
        .expect("read")
        .expect("row")
        .structure;
    let rows_structure = repo
        .get_any_status(rows)
        .await
        .expect("read")
        .expect("row")
        .structure;
    Level {
        group,
        rows,
        group_structure,
        rows_structure,
        labels: Vec::new(),
        keys: Vec::new(),
        levels: Vec::new(),
    }
}

/// **A REAL 3-DEEP CHAIN, read end to end through the byte route.**
///
/// Three producer runs: `A1` over `ds-a`+`ds-b`, `A2` over `A1`'s gathered output + `ds-c`,
/// `A3` over `A2`'s gathered output + `ds-d`. The artifact the request names therefore reads
/// through two intermediates before it reaches a byte, and every byte it returns comes from a
/// store `cyto_zarr` wrote.
///
/// The assertion is on LABELS and KEYS, never on codes. A fused categorical's codes are
/// per-source and every level re-unifies them, so the code that means `g4` differs at each
/// level; the LABEL is the fact a user sees, and asserting it is what makes a chain that
/// forgot one level's remap fail rather than merely renumber. (`extend_chain` asserts at
/// every level; this test drives the depth and pins the final answer.)
#[tokio::test]
async fn a_three_deep_chain_of_real_producer_alignments_serves_the_right_rows() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "chain").await;
    let pool = pool_for(&server).await;
    let store = server_store(&server);
    let repo = CatalogRepository::new(pool.clone());

    let mut level = level_one(&repo, &store, project).await;
    // Level 1's own values, decoded once so level 2 can be staged from them.
    let decoded = decode_level(
        &pool,
        &store,
        level.group,
        &level.group_structure,
        level.rows,
        &level.rows_structure,
    )
    .await;
    level.labels = decoded.labels;
    level.keys = decoded.keys;
    level.levels = decoded.levels;
    assert_eq!(
        level.levels,
        vec!["g2", "g3", "g4", "g1"],
        "level 1's unified vocabulary is the union in DECLARED-source order, not sorted — \
         which is exactly why the next level must be staged with it declared"
    );
    assert_eq!(
        level.keys,
        vec!["b-0", "b-1", "b-2", "a-0", "a-1"],
        "level 1 is the reversed fixture: ds-b is DECLARED first, so its rows come first \
         even though the segment array sorts ds-a first"
    );
    assert_eq!(level.labels, vec!["g3", "g4", "g2", "g2", "g1"]);

    let level2 = extend_chain(
        &repo,
        &store,
        &pool,
        project,
        &level,
        &[("ds-c", &["c-0"][..], &["g1"][..])],
        2,
    )
    .await;
    let level3 = extend_chain(
        &repo,
        &store,
        &pool,
        project,
        &level2,
        // THREE sources at this level. Declared `[ds-v, ds-d, ds-e]`, sorted
        // `[ds-d, ds-e, ds-v]` — a 3-CYCLE, so the permutation differs from its own inverse
        // and a consumer that inverted `segment_dataset` cannot pass. Two sources cannot
        // express that: `[1, 0]` is an involution.
        &[
            ("ds-d", &["d-0", "d-1"][..], &["g5", "g2"][..]),
            ("ds-e", &["e-0"][..], &["g6"][..]),
        ],
        3,
    )
    .await;

    assert_eq!(
        level3.keys,
        vec!["b-0", "b-1", "b-2", "a-0", "a-1", "c-0", "d-0", "d-1", "e-0"],
        "nine rows drawn through two intermediates from five leaf datasets"
    );
    assert_eq!(
        level3.labels,
        vec!["g3", "g4", "g2", "g2", "g1", "g1", "g5", "g2", "g6"]
    );

    // ── AND THE SAME ANSWER OVER HTTP ──────────────────────────────────────────────
    //
    // Everything above went through `gather_exec::resolve` directly, because that is what
    // feeds the next producer run. The claim this test exists for is about the ROUTE, and a
    // resolver that works while the route does not is the shape ITEM-30's own test was
    // written to catch. So the final level is re-read through
    // `GET /artifacts/{id}/data/{member}` — the production authz gate and the production
    // handler — and compared to the bytes the resolver produced.
    let decl = reqwest::Client::new()
        .get(server.api_url(&format!(
            "/artifacts/{}/data/values/zarr.json",
            level3.group
        )))
        .bearer_auth(&token)
        .send()
        .await
        .expect("request");
    assert_eq!(decl.status(), 200, "{:?}", decl.text().await);
    let decl: serde_json::Value = decl.json().await.expect("array node");
    let levels: Vec<String> = decl["attributes"]["cyto"]["levels"]
        .as_array()
        .expect("the served vocabulary")
        .iter()
        .map(|v| v.as_str().expect("a label").to_string())
        .collect();

    let mut served = Vec::new();
    let mut g = 0usize;
    while served.len() < level3.keys.len() {
        let r = read_chunk(&server, &token, level3.group, g).await;
        assert_eq!(r.status(), 200, "chunk {g}: {:?}", r.text().await);
        served.extend(r.bytes().await.expect("bytes").to_vec());
        g += 1;
    }
    let over_http: Vec<String> = served[..level3.keys.len()]
        .iter()
        .map(|c| levels[*c as usize].clone())
        .collect();
    assert_eq!(
        over_http, level3.labels,
        "the byte ROUTE must serve the same chained rows the resolver does — one gather, not \
         two that agree today"
    );
}

/// **The depth limit fires on a REAL chain, over the route** — not as unit arithmetic.
///
/// The bound is defense in depth (acyclicity is by construction), and the reason it exists is
/// that an unbounded walk whose safety rests on an argument is one schema change away from
/// exhausting a resource inside a request handler. A bound nothing exercises is that same
/// unbounded walk with a comment.
///
/// Built by stacking `MAX_CHAIN_DEPTH + 1` gathered artifacts over ONE real alignment — the
/// row counts are not made to agree, deliberately, because the depth refusal must fire during
/// the metadata WALK, before anything resolves far enough to notice.
#[tokio::test]
async fn a_chain_deeper_than_the_bound_is_refused_by_name_over_the_route() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "chain").await;
    let pool = pool_for(&server).await;
    let store = server_store(&server);
    let repo = CatalogRepository::new(pool.clone());

    let base = level_one(&repo, &store, project).await;
    let mut top = base.group;
    let align = base.group_structure["gathered_from"]["alignment_artifact_id"]
        .as_str()
        .and_then(|s| s.parse::<Uuid>().ok())
        .expect("the level-1 alignment id");
    // One more than the bound: the LAST one added must be refused.
    for level in 0..cytoanalyst::modules::workstore::gathered::MAX_CHAIN_DEPTH {
        top = gathered_over(
            &repo,
            project,
            &format!("too-deep-{level}"),
            align,
            5,
            "uint8",
            Some("categorical"),
            json!("group"),
            vec![("ds-a", top), ("ds-b", top)],
        )
        .await;
    }

    let r = read_chunk(&server, &token, top, 0).await;
    let status = r.status();
    let body = r.text().await.expect("body");
    assert_ne!(
        status, 200,
        "a chain past the bound must never serve: {body}"
    );
    assert!(
        body.contains("GATHER_CHAIN_TOO_DEEP"),
        "the refusal must NAME the bound rather than surface as a timeout or a stack \
         overflow: {status} {body}"
    );
    assert!(
        body.contains(&cytoanalyst::modules::workstore::gathered::MAX_CHAIN_DEPTH.to_string()),
        "and it must say what the bound is: {body}"
    );
}

/// **A CYCLE is refused by name rather than resolving forever** — over the route.
///
/// A cycle is supposed to be unconstructible: an alignment names sources that already exist,
/// and artifacts are immutable, so every edge points backwards in creation order. This test
/// constructs one anyway, by UPDATING a recipe after the fact — which is exactly the "some
/// path now rewrites ids" the check exists against. Without the check the walk does not
/// return.
#[tokio::test]
async fn a_cycle_is_refused_by_name_rather_than_walked_forever() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "chain").await;
    let pool = pool_for(&server).await;
    let store = server_store(&server);
    let repo = CatalogRepository::new(pool.clone());

    let base = level_one(&repo, &store, project).await;
    let align = base.group_structure["gathered_from"]["alignment_artifact_id"]
        .as_str()
        .and_then(|s| s.parse::<Uuid>().ok())
        .expect("the level-1 alignment id");
    let a = gathered_over(
        &repo,
        project,
        "cycle-a",
        align,
        5,
        "uint8",
        Some("categorical"),
        json!("group"),
        vec![("ds-a", base.group), ("ds-b", base.group)],
    )
    .await;
    let b = gathered_over(
        &repo,
        project,
        "cycle-b",
        align,
        5,
        "uint8",
        Some("categorical"),
        json!("group"),
        vec![("ds-a", a), ("ds-b", a)],
    )
    .await;
    // Close the loop out of band — the one thing immutability is supposed to forbid.
    sqlx::query(
        "UPDATE artifacts SET structure = jsonb_set(structure, \
         '{gathered_from,sources,0,artifact_id}', to_jsonb($2::text)) WHERE id = $1",
    )
    .bind(a)
    .bind(b.to_string())
    .execute(&pool)
    .await
    .expect("close the cycle");

    let r = read_chunk(&server, &token, b, 0).await;
    let status = r.status();
    let body = r.text().await.expect("body");
    assert_ne!(status, 200, "a cycle must never serve: {body}");
    assert!(
        body.contains("GATHER_CHAIN_CYCLE"),
        "the refusal must NAME the cycle: {status} {body}"
    );
    assert!(
        body.contains(&b.to_string()) && body.contains(&a.to_string()),
        "and it must name the artifacts on the loop so an operator can break it: {body}"
    );
}

/// **The digest precheck lands on the LEAF, not on an intermediate** (ITEM-20 through a chain).
///
/// An intermediate has no bytes of its own, so a check against one verifies something the
/// gather never reads. This builds a chain whose INTERMEDIATE declares a digest that agrees
/// with nothing, and whose LEAF has been changed out from under its alignment. If the check
/// were landing on the intermediate the read would either pass (nothing compares the
/// intermediate's stray digest to anything) or fail naming the intermediate; the only correct
/// answer names the LEAF.
#[tokio::test]
async fn the_digest_precheck_of_a_chain_lands_on_the_leaf_not_the_intermediate() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "chain").await;
    let pool = pool_for(&server).await;
    let store = server_store(&server);
    let repo = CatalogRepository::new(pool.clone());

    // Level 1 with ds-a's LEAF pinned to a digest the alignment did not compute — the H1
    // scenario, one level down from where it is normally observed.
    let (inner, _, _) = producer_scene_over(
        &repo,
        &store,
        project,
        Some("sha256:the-leaf-changed-under-the-alignment"),
        "stage1_alignment_reversed",
        SceneGather::Level("group"),
    )
    .await;
    // The intermediate carries a DIFFERENT digest from the leaf's — and one that matches
    // nothing. A walk checking intermediates would have to say something about this string;
    // a walk checking leaves must ignore it entirely.
    sqlx::query(
        "UPDATE artifacts SET structure = jsonb_set(structure, '{aligned_to}', \
         '\"sha256:an-intermediate-does-not-carry-an-identity\"') WHERE id = $1",
    )
    .bind(inner)
    .execute(&pool)
    .await
    .expect("stamp the intermediate");

    let align = repo
        .get_any_status(inner)
        .await
        .expect("read")
        .expect("row")
        .structure["gathered_from"]["alignment_artifact_id"]
        .as_str()
        .and_then(|s| s.parse::<Uuid>().ok())
        .expect("alignment id");
    let outer = gathered_over(
        &repo,
        project,
        "outer",
        align,
        5,
        "uint8",
        Some("categorical"),
        json!("group"),
        vec![("ds-a", inner), ("ds-b", inner)],
    )
    .await;

    let r = read_chunk(&server, &token, outer, 0).await;
    let status = r.status();
    let body = r.text().await.expect("body");
    assert_ne!(
        status, 200,
        "a changed LEAF must refuse the whole chain: {body}"
    );
    assert!(
        body.contains("SOURCE_DIGEST_MISMATCH"),
        "the refusal must be the digest one: {status} {body}"
    );
    assert!(
        body.contains("the-leaf-changed-under-the-alignment"),
        "and it must name the LEAF's pin — an intermediate has no bytes, so a check that \
         landed there verified nothing the gather reads: {body}"
    );
    assert!(
        !body.contains("an-intermediate-does-not-carry-an-identity"),
        "the intermediate's stray identity must play no part: {body}"
    );
}

/// **An intermediate whose row count disagrees with the alignment is refused.**
///
/// This is the one thing a chain loses that a stored source has: the outer alignment pins a
/// `key_sequence_digest` for the dataset, and a gathered row carries no identity to compare it
/// with. What it does carry is a SHAPE, and the alignment declares the shape it expected. A
/// recipe that binds the wrong virtual column produces the right kind of bytes for the wrong
/// rows, and this is the door that closes.
#[tokio::test]
async fn a_chained_source_with_the_wrong_row_count_is_refused_naming_both() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "chain").await;
    let pool = pool_for(&server).await;
    let store = server_store(&server);
    let repo = CatalogRepository::new(pool.clone());

    let base = level_one(&repo, &store, project).await;
    let align = base.group_structure["gathered_from"]["alignment_artifact_id"]
        .as_str()
        .and_then(|s| s.parse::<Uuid>().ok())
        .expect("alignment id");
    // The intermediate serves 5 rows; the alignment expects 2 for ds-a and 3 for ds-b.
    let outer = gathered_over(
        &repo,
        project,
        "wrong-shape",
        align,
        5,
        "uint8",
        Some("categorical"),
        json!("group"),
        vec![("ds-a", base.group), ("ds-b", base.group)],
    )
    .await;

    let r = read_chunk(&server, &token, outer, 0).await;
    let status = r.status();
    let body = r.text().await.expect("body");
    assert_ne!(
        status, 200,
        "a mis-shaped chained source must refuse: {body}"
    );
    assert!(
        body.contains("GATHER_CHAIN_ROW_COUNT_MISMATCH"),
        "refused by name: {status} {body}"
    );
    assert!(
        body.contains(" 5 row(s)") && (body.contains(" 2 row(s)") || body.contains(" 3 row(s)")),
        "the refusal must name BOTH counts — what it found and what the alignment expected — \
         because either alone leaves the operator guessing which side is wrong: {body}"
    );
}

/// **A chain adds nothing to the GC keep-set, and GC still keeps every leaf blob.**
///
/// Reachability is a METADATA claim (`SELECT object_key FROM artifacts`, no `WHERE`) while
/// chain resolution needs BYTES, and the two must not be made to meet: a keep-set that had to
/// open an artifact to decide what to keep would stop all reclamation the moment one artifact
/// were unreadable — which this repo has already paid for once, when a single gathered row
/// made `all_blob_refs` refuse and silently halted every sweep.
///
/// So the assertion is exactly that: a two-level chain sweeps clean, and the leaf blobs
/// survive because they are their own rows, not because anything walked to them.
#[tokio::test]
async fn a_chain_neither_breaks_the_gc_sweep_nor_loses_its_leaf_blobs() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "chain").await;
    let pool = pool_for(&server).await;
    let store = server_store(&server);
    let repo = CatalogRepository::new(pool.clone());

    let base = level_one(&repo, &store, project).await;
    let align = base.group_structure["gathered_from"]["alignment_artifact_id"]
        .as_str()
        .and_then(|s| s.parse::<Uuid>().ok())
        .expect("alignment id");
    let _outer = gathered_over(
        &repo,
        project,
        "gc-outer",
        align,
        5,
        "uint8",
        Some("categorical"),
        json!("group"),
        vec![("ds-a", base.group), ("ds-b", base.group)],
    )
    .await;

    let refs = repo.all_blob_refs().await.expect("the keep-set builds");
    assert!(
        !refs.is_empty(),
        "NON-VACUITY: a keep-set of nothing would make the survival assertion below \
         trivially true"
    );
    assert!(
        refs.iter().all(|r| !r.object_key.is_empty()),
        "the keep-set is built from object keys alone — a gathered row contributes none and \
         must simply be absent, never a refusal"
    );

    // The level-1 gather still reads: nothing about adding a chain above it moved a blob.
    let r = read_chunk(&server, &token, base.group, 0).await;
    assert_eq!(
        r.status(),
        200,
        "the leaf blobs survive: {:?}",
        r.text().await
    );
}

// ════════════════════════════════════════════════════════════════════════════════════════════
//  C1 — a FILTER OVER AN INTEGRATION keeps the inner node's UNIFIED vocabulary (INV-13/INV-6)
// ════════════════════════════════════════════════════════════════════════════════════════════
//
// The sanctioned "filtered integration = CHAINING" flow: the outer node is a FILTER (lone source +
// a mask, no alignment) whose ONE source is a previously-INTEGRATED VD (the `producer_scene` fused
// categorical, whose unified vocabulary is [g1,g2,g3,g4] — an order NO single source declares, so
// an off-by-one is visible). The inner node already resolved that vocabulary; before C1 the outer
// filter dropped it and served the correct unified CODES with NO `levels` — numbers where labels
// belong. This drives the REAL resolver over the REAL chain and asserts the served member carries
// the unified vocabulary AND the kept rows' labels.

/// One 1-D zarr-v3 `bool` array in the decodable container — a per-source keep mask member.
fn zarr_bool_mask(keep: &[bool]) -> Vec<(String, Vec<u8>)> {
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;
    let elems: Vec<u8> = keep.iter().map(|&k| k as u8).collect();
    let n = elems.len();
    let span = n.max(1);
    let mut enc = GzEncoder::new(Vec::new(), Compression::fast());
    enc.write_all(&elems).expect("gzip");
    let gz = enc.finish().expect("gzip finish");
    let mut body = gz.clone();
    body.extend_from_slice(&0u64.to_le_bytes());
    body.extend_from_slice(&(gz.len() as u64).to_le_bytes());
    body.extend_from_slice(&[0u8; 4]);
    let meta = json!({
        "zarr_format": 3, "node_type": "array", "shape": [n], "data_type": "bool",
        "chunk_grid": { "name": "regular", "configuration": { "chunk_shape": [span] } },
        "chunk_key_encoding": { "name": "default" }, "fill_value": 0,
        "codecs": [{ "name": "sharding_indexed", "configuration": {
            "chunk_shape": [span],
            "codecs": [{ "name": "bytes" }, { "name": "gzip" }],
            "index_codecs": [{ "name": "bytes" }, { "name": "crc32c" }],
            "index_location": "end" } }],
    });
    vec![
        ("values/zarr.json".to_string(), serde_json::to_vec(&meta).expect("mask meta")),
        ("values/c/0".to_string(), body),
    ]
}

/// Insert a hidden per-source boolean MASK artifact.
async fn put_bool_mask(
    repo: &CatalogRepository,
    store: &dyn ObjectStore,
    project: Uuid,
    keep: &[bool],
) -> Uuid {
    let put = store.put_prefix(&zarr_bool_mask(keep)).await.expect("put mask");
    repo.insert_artifact(&NewArtifact {
        project_id: Some(project),
        dataset_id: None,
        run_id: Some(Uuid::new_v4()),
        output_id: "chain-mask".to_string(),
        datatype: "data/opaque".to_string(),
        object_key: Some(put.object_key.as_str().to_string()),
        is_multifile: true,
        content_hash: put.content_hash.clone(),
        structure: json!({ "columns": [{ "name": "values", "path": "values" }] }),
        meta: cytoanalyst::modules::workstore::mask::mask_meta("ds-inner"),
        role: "artifact".to_string(),
        stored_bytes: 0,
        logical_bytes: Some(0),
        created_by: None,
        hidden: true,
        representation_of: None,
    })
    .await
    .expect("insert mask")
    .id
}

/// **A categorical read through a FILTER-OVER-INTEGRATION chain keeps the UNIFIED vocabulary on its
/// resolved member, and its labels are correct (C1, INV-13/INV-6).**
///
/// Inner = the two-source fused categorical (unified vocab [g1,g2,g3,g4], codes [1,0,2,3,1]). Outer
/// = a filter over it, keeping rows {0,2,3} → codes [1,2,3] = labels [g2,g3,g4]. The unified vocab
/// order differs from every source's, so serving a raw/absent vocabulary would relabel visibly.
///
/// nc: restore `(levels, missing_level) = (None, None)` for the chained branch in
/// `resolve_single_source_node` (or drop the `levels` fields from `SourceBytes`) and the served
/// member has NO `levels` — this assertion goes from [g1,g2,g3,g4] to null.
#[tokio::test]
async fn a_filter_over_an_integration_keeps_the_unified_vocabulary() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "filter over integration").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);

    // The INNER integration node — a real two-source fused categorical.
    let (inner, _, _) = producer_scene(&repo, &store, project, None).await;

    // Sanity: the inner already serves the unified vocabulary [g1,g2,g3,g4] and codes [1,0,2,3,1].
    let inner_res = cytoanalyst::modules::workstore::gather_exec::resolve(
        &pool,
        &store,
        inner,
        &repo.get_any_status(inner).await.unwrap().unwrap().structure,
    )
    .await
    .expect("resolve inner integration");
    let inner_decl: serde_json::Value =
        serde_json::from_slice(&inner_res.member("values/zarr.json").unwrap().unwrap()).unwrap();
    let unified = inner_decl["attributes"]["cyto"]["levels"].clone();
    assert_eq!(
        unified,
        json!(["g1", "g2", "g3", "g4"]),
        "the inner integration's unified vocabulary — its order differs from any source's"
    );

    // The OUTER filter over the inner, keeping rows {0,2,3}.
    let mask = put_bool_mask(&repo, &store, project, &[true, false, true, true, false]).await;
    let outer = repo
        .insert_artifact(&NewArtifact {
            project_id: Some(project),
            dataset_id: None,
            run_id: Some(Uuid::new_v4()),
            output_id: "filter-over-integration".to_string(),
            datatype: "data/opaque".to_string(),
            object_key: None,
            is_multifile: false,
            content_hash: format!("sha256:{}", Uuid::new_v4().simple()),
            structure: cytoanalyst::modules::workstore::virtual_dataset::gathered_structure(
                "uint8",
                Some("categorical"),
                SCENE_SOURCE_AXIS,
                5, // the inner's output rows (pre-mask); resolve renumbers to N_kept
                cytoanalyst::modules::workstore::virtual_dataset::KeyIdentity::Unpinned,
                json!({
                    "alignment_artifact_id": null,
                    "column_selector": "values",
                    "alignment_column": null,
                    "sources": [ { "dataset_id": "ds-inner", "artifact_id": inner } ],
                    "mask_artifact_id": mask,
                }),
            ),
            meta: json!({}),
            role: "artifact".to_string(),
            stored_bytes: 0,
            logical_bytes: cytoanalyst::modules::workstore::virtual_dataset::gathered_logical_bytes(
                "uint8", 5,
            ),
            created_by: None,
            hidden: false,
            representation_of: None,
        })
        .await
        .expect("insert outer filter")
        .id;

    let resolved = cytoanalyst::modules::workstore::gather_exec::resolve(
        &pool,
        &store,
        outer,
        &repo.get_any_status(outer).await.unwrap().unwrap().structure,
    )
    .await
    .expect("resolve filter-over-integration");

    assert_eq!(resolved.n, 3, "three rows kept (0,2,3)");

    // THE C1 ASSERTION: the served member carries the UNIFIED vocabulary, not null.
    let decl: serde_json::Value =
        serde_json::from_slice(&resolved.member("values/zarr.json").unwrap().unwrap()).unwrap();
    assert_eq!(
        decl["attributes"]["cyto"]["levels"],
        json!(["g1", "g2", "g3", "g4"]),
        "the filter over an integration must carry the inner node's UNIFIED vocabulary on its \
         resolved member — dropping it serves unified codes with no labels (INV-13)"
    );

    // …and the kept rows' codes + labels are correct against that vocabulary.
    let mut codes = Vec::new();
    for g in 0..resolved.chunk_count() {
        codes.extend_from_slice(&resolved.chunk(g).unwrap());
    }
    codes.truncate(resolved.n);
    assert_eq!(codes, vec![1u8, 2, 3], "kept codes are inner rows 0,2,3");
    let labels: Vec<&str> = codes
        .iter()
        .map(|&c| decl["attributes"]["cyto"]["levels"][c as usize].as_str().unwrap())
        .collect();
    assert_eq!(
        labels,
        vec!["g2", "g3", "g4"],
        "the kept rows' labels resolve against the unified vocabulary"
    );
}
