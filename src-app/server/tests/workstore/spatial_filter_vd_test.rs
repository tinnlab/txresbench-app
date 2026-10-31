//! **#157 INV-6 — what a filter ACTUALLY does to a spatially-imported dataset's siblings.**
//!
//! `docs/design/spatial-storage-layout.md` §9, fourth constraint, is the only clause in the
//! whole backwards-compatibility section that the design refuses to assert. **Paraphrased
//! here, deliberately not quoted**, and the reason is measured rather than assumed:
//! `src-app/ui/scripts/lint-no-domain-in-builtin.mjs` scans `server/tests/**` as one of its
//! roots (`serverTests`), and an earlier version of this file that DID quote the clause drew
//! 90 findings from it — among them the very tokens this clause is made of. (It is a
//! different guard from `scripts/check-derived-vocabulary.sh`, which does exclude test
//! paths; conflating the two is easy and has been done.) Silently rewriting words inside
//! quotation marks would make a false claim about what the design says, so the clause is
//! paraphrased openly instead. The verbatim text is in the design doc and in this branch's
//! `PLAN.md` `## Invariants`:
//!
//! * filtering must CARRY the spatial siblings;
//! * the filter analysis emits a filtered matrix and a keep-mask;
//! * the tissue map is row-aligned, carrying `aligned_to` + `membership`, so (the design
//!   argues) the carrying mechanism already exists and is the one used for reduced layouts;
//! * and then — with TWO substitutions, the analysis name and the alignment adjective —
//!   **"Verify, don't assume:"** whether the filter analysis re-emits or merely invalidates
//!   row-aligned siblings *"is a behaviour I did not read. Filed as a child item with a test
//!   as its acceptance."* (The two spans inside quotation marks are verbatim; the connective
//!   between them is not.)
//!
//! This file is that test. It answers the question by RUNNING the production sink over the
//! real artifact shapes and reading back what is served.
//!
//! ## Why this is not `filter_vd_test.rs`, and not a Python test
//!
//! Not Python: the filter analysis's compute emits a keep-mask and a report and **nothing else** —
//! no filtered matrix, no re-emitted sibling (pinned by
//! the Python half's `…_emits_a_mask_and_no_filtered_matrix` test).
//! The carrying happens SERVER-SIDE, in `create_filter_vd_for_run`, which iterates every usable
//! artifact in the source dataset and mints one gathered row each. The behaviour §9 asks about
//! does not live in the compute at all.
//!
//! Not `filter_vd_test.rs`: that file's §P2 header states its two #203 tests are "expected to be
//! rewritten when #203 lands, not preserved". These assertions are the opposite — they are the
//! PINNED ANSWER to a design invariant and must survive a #203 fix by going red and being
//! re-derived, never by being deleted with the section that housed them.
//!
//! ## What is genuinely new here, versus `filter_vd_test.rs` §P2
//!
//! §P2 already puts a 2-D artifact through a filter VD. Its fixture names the member
//! **`values`** — and that one choice is the difference between the two failure modes, because
//! `gathered_structure` hardcodes `column_selector: SOURCE_MEMBER` (`virtual_dataset.rs:180`,
//! `"values"`). A source whose member happens to be called `values` therefore serves
//! *silently wrong numbers*; a source whose member is called anything else names a member the
//! store does not have.
//!
//! The real importer writes its member as **`coordinates`**
//! (its writer names the member `coordinates`), so
//! the shipped Visium artifact is in the SECOND case, which nothing had measured. That is the
//! gap this file closes, and it is a materially better outcome than the one #203's headline
//! describes: for the artifact this epic actually produces, the defect is **loud**.
//!
//! ## What this file does NOT do
//!
//! It does not fix #203 or #211. Every assertion that describes wrong behaviour says so in its
//! message and names the production line responsible, so the record is a measurement and never
//! an endorsement.
//!
//! ## Two tests here are DELIBERATE duplicates, and why that is worth the maintenance
//!
//! `the_option_a_siblings_serve_the_kept_spots_coordinates` and
//! `a_post_filter_colour_column_serves_kept_codes_with_its_levels` have close twins in
//! `filter_vd_test.rs` (`the_option_a_siblings_serve_the_kept_rows_values` at :1428 and
//! `a_post_filter_colour_column_serves_the_kept_rows_codes_and_levels` at :1515). The
//! duplication is intentional: those twins live in a section whose own header licenses their
//! DELETION when #203 lands, and they are the POSITIVE CONTROL for everything else in this
//! file — without a sibling that resolves correctly in the same scene, "the tissue map does
//! not resolve" would be indistinguishable from "the fixture or the store is broken". A
//! control that can be deleted by an unrelated fix is not a control. Both are also extended
//! here beyond their twins: the coordinates carry x and y three orders of magnitude apart so
//! an interleaving is unmistakable, and the colour assertions run over the SERVED bytes
//! rather than over test-local constants.

use serde_json::{json, Value};
use std::path::PathBuf;
use uuid::Uuid;

use cytoanalyst::modules::sandbox::inputs::materialize_inputs;
use cytoanalyst::modules::sandbox::spec::AnalysisSpec;
use cytoanalyst::modules::workstore::catalog::models::NewArtifact;
use cytoanalyst::modules::workstore::catalog::repository::CatalogRepository;
use cytoanalyst::modules::workstore::gather_exec::{resolve, ResolvedGather};
use cytoanalyst::modules::workstore::object_store::{LocalFsStore, ObjectStore};
use cytoanalyst::modules::workstore::virtual_dataset::{create_filter_vd_for_run, FilterOutcome};

use crate::common::TestServer;
use crate::dataset::create_dataset;
use crate::dataset::hardening_common::{admin_user_id, insert_running_job};

use super::{pool_for, server_store, setup_admin};

// ── the scene ───────────────────────────────────────────────────────────────────────────────
//
// Nine spots; the mask keeps 0, 3, 6, 7. Deliberately neither a prefix nor a contiguous run:
// a gather that truncated to the first k rows, or dropped the mask entirely, would satisfy a
// length check and a `0..k` expectation and must not satisfy this one.
const N: usize = 9;
const KEEP: [bool; N] = [true, false, false, true, false, false, true, true, false];
const KEPT_ROWS: [usize; 4] = [0, 3, 6, 7];
const LABEL: &str = "In tissue, high counts";

/// The member name the SHIPPED visium importer writes for the tissue-map datatype.
///
/// The whole point of this file. `virtual_dataset::SOURCE_MEMBER` is the literal `"values"`,
/// and this is not it.
const COORDINATES_MEMBER: &str = "coordinates";

/// Spot `i` sits at `(100 + 10i, 5000 + i)` in full-resolution pixels.
///
/// The two components are separated by three orders of magnitude ON PURPOSE. A gather that
/// interleaves them, transposes them, or serves one where the other belongs produces numbers
/// that are OBVIOUSLY from the wrong component — whereas coordinates of a similar magnitude
/// would let an interleaving pass for plausible data, which is exactly how #203 stayed
/// unnoticed.
fn coordinates() -> Vec<[f32; 2]> {
    (0..N)
        .map(|i| [100.0 + 10.0 * i as f32, 5000.0 + i as f32])
        .collect()
}

fn kept<T: Copy>(all: &[T]) -> Vec<T> {
    all.iter()
        .zip(KEEP.iter())
        .filter_map(|(v, &k)| k.then_some(*v))
        .collect()
}

// ── zarr fixture builders ───────────────────────────────────────────────────────────────────
//
// Re-declared here rather than shared with `filter_vd_test.rs`. Widening that file's private
// helpers would be an edit to a file this branch otherwise has no business in, and B3 forbids
// changing shared test infrastructure to route around one's own needs. They are ~40 lines and
// they encode the codec chain the gather is permitted to decode.

fn zarr_meta(dtype: &str, shape: Value, chunk_shape: Value) -> Value {
    json!({
        "zarr_format": 3,
        "node_type": "array",
        "shape": shape,
        "data_type": dtype,
        "chunk_grid": { "name": "regular", "configuration": { "chunk_shape": chunk_shape } },
        "chunk_key_encoding": { "name": "default" },
        "fill_value": 0,
        "codecs": [{
            "name": "sharding_indexed",
            "configuration": {
                "chunk_shape": chunk_shape,
                "codecs": [{ "name": "bytes" }, { "name": "gzip" }],
                "index_codecs": [{ "name": "bytes" }, { "name": "crc32c" }],
                "index_location": "end"
            }
        }],
    })
}

fn zarr_member(prefix: &str, meta: Value, elems: Vec<u8>) -> Vec<(String, Vec<u8>)> {
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;

    let mut enc = GzEncoder::new(Vec::new(), Compression::fast());
    enc.write_all(&elems).expect("gzip");
    let gz = enc.finish().expect("gzip finish");

    let mut body = gz.clone();
    body.extend_from_slice(&0u64.to_le_bytes());
    body.extend_from_slice(&(gz.len() as u64).to_le_bytes());
    body.extend_from_slice(&[0u8; 4]);

    vec![
        (format!("{prefix}/zarr.json"), serde_json::to_vec(&meta).expect("array meta")),
        (format!("{prefix}/c/0"), body),
    ]
}

fn zarr_array_1d(
    prefix: &str,
    dtype: &str,
    item: usize,
    elems: Vec<u8>,
    levels: Option<Value>,
) -> Vec<(String, Vec<u8>)> {
    let n = elems.len() / item;
    let mut meta = zarr_meta(dtype, json!([n]), json!([n.max(1)]));
    if let Some(levels) = levels {
        meta["attributes"] = json!({ "cyto": { "kind": "categorical", "levels": levels } });
    }
    zarr_member(prefix, meta, elems)
}

fn zarr_array_2d(prefix: &str, width: usize, elems: Vec<u8>) -> Vec<(String, Vec<u8>)> {
    let n = elems.len() / (4 * width);
    zarr_member(prefix, zarr_meta("float32", json!([n, width]), json!([n.max(1), width])), elems)
}

/// **The `structure` the SHIPPED importer declares on its tissue-map artifact.**
///
/// Taken from a real importer run, not invented: the shared column writer files the
/// `(n × 2)` member under `arrays` (because `cyto_zarr.Table._record` files by rank) with
/// `columns` EMPTY, carries the top-level `n`, and stamps `aligned_to` + `memberships` because
/// the artifact is row-aligned. Those last two are the ones §9 says the carrying mechanism
/// rests on.
fn coordinates_structure(member: &str, axis: &str, n: usize, aligned_to: &str) -> Value {
    json!({
        "encoding": "zarr_v3",
        "kind": "table",
        "axis": axis,
        "n": n,
        "columns": [],
        "arrays": [{
            "path": member, "name": member, "kind": "numeric",
            "dtype": "float32", "shape": [n, 2], "axis": axis, "n": n,
        }],
        "aligned_to": aligned_to,
        "memberships": [{ "axis": axis, "aligned_to": aligned_to, "kind": "full", "n_members": n }],
    })
}

fn one_d_structure(axis: &str, n: usize, kind: &str, dtype: &str, aligned_to: &str) -> Value {
    json!({
        "encoding": "zarr_v3", "kind": "table", "axis": axis, "n": n,
        "columns": [{ "name": "values", "path": "values", "kind": kind,
                      "dtype": dtype, "shape": [n], "axis": axis, "n": n }],
        "arrays": [],
        "aligned_to": aligned_to,
        "memberships": [{ "axis": axis, "aligned_to": aligned_to, "kind": "full", "n_members": n }],
    })
}

async fn put_stored(
    repo: &CatalogRepository,
    store: &dyn ObjectStore,
    dataset: Uuid,
    output_id: &str,
    datatype: &str,
    members: Vec<(String, Vec<u8>)>,
    structure: Value,
    meta: Value,
    run_id: Option<Uuid>,
) -> Uuid {
    let put = store.put_prefix(&members).await.expect("put_prefix");
    repo.insert_artifact(&NewArtifact {
        project_id: None,
        dataset_id: Some(dataset),
        run_id,
        output_id: output_id.into(),
        datatype: datatype.into(),
        object_key: Some(put.object_key.as_str().to_string()),
        is_multifile: true,
        content_hash: put.content_hash.clone(),
        structure,
        meta,
        role: "artifact".into(),
        stored_bytes: 0,
        logical_bytes: Some(0),
        created_by: None,
        hidden: false,
        representation_of: None,
    })
    .await
    .expect("insert stored source")
    .id
}

/// What a spatially-imported dataset puts on its entity axis that a filter must carry:
/// the 2-D tissue map, its two Option-A 1-D siblings, a categorical colour column, and the
/// run-produced marked keep-mask.
struct SpatialScene {
    pool: sqlx::SqlitePool,
    store: LocalFsStore,
    repo: CatalogRepository,
    owner: Uuid,
    job_id: Uuid,
    coordinates: Uuid,
    spatial_x: Uuid,
    spatial_y: Uuid,
    colour: Uuid,
    matrix: Uuid,
    aligned_to: String,
}

/// The `aligned_to` digest every row-aligned artifact on this dataset is stamped with — a bare
/// 64-hex string, the shape `cyto_columns.axis_key_digest` produces.
const ROWS_DIGEST: &str = "acccbf49d40fe2e264f9b194136a8f12b6c2bdf58154ed279262abf97c3d80e0";

async fn spatial_scene(server: &TestServer, name: &str) -> SpatialScene {
    spatial_scene_named(server, name, COORDINATES_MEMBER).await
}

/// The same scene with the 2-D coordinates member named `member`.
///
/// The name is the one variable that decides between #203's loud arm and its silent one, so it
/// is a parameter rather than a constant — see
/// `the_member_name_is_the_switch_between_a_loud_and_a_silent_filter`.
async fn spatial_scene_named(server: &TestServer, name: &str, member: &str) -> SpatialScene {
    let token = setup_admin(server).await;
    let pool = pool_for(server).await;
    let owner = admin_user_id(&pool).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(server);
    let source: Uuid = create_dataset(server, &token, name).await.parse().unwrap();

    // The counts matrix. Present because the sink reads the source dataset off the run's
    // `expression` binding, and because a filter must gather it too.
    let matrix_key = format!("sha256:{}", Uuid::new_v4().simple());
    let matrix = repo
        .insert_artifact(&NewArtifact {
            project_id: None,
            dataset_id: Some(source),
            run_id: None,
            output_id: "expression".into(),
            datatype: "data/opaque".into(),
            object_key: Some(matrix_key.clone()),
            is_multifile: true,
            content_hash: matrix_key,
            structure: json!({
                "encoding": "zarr_v3", "kind": "sparse_csc",
                "axes": ["rows", "cols"], "shape": [N, 4], "nnz": 12,
            }),
            meta: json!({ "kind": "counts", "platform": "visium" }),
            role: "artifact".into(),
            stored_bytes: 128,
            logical_bytes: Some(128),
            created_by: None,
            hidden: false,
            representation_of: None,
        })
        .await
        .expect("insert the counts matrix")
        .id;

    let coords = coordinates();
    let xs: Vec<f32> = coords.iter().map(|c| c[0]).collect();
    let ys: Vec<f32> = coords.iter().map(|c| c[1]).collect();

    let coordinates_id = put_stored(
        &repo, &store, source, "layout-xy", "data/opaque",
        zarr_array_2d(
            member, 2,
            coords.iter().flat_map(|xy| xy.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>()).collect(),
        ),
        coordinates_structure(member, "rows", N, ROWS_DIGEST),
        // The `meta` the shipped importer stamps. `component_columns` rides HERE because the
        // gather re-mints `structure` and copies `meta` verbatim — which this file checks.
        json!({
            "name": "coordinates", "kind": "layout-xy", "axis": "rows", "n": N,
            "n_dims": 2, "unit": "pixel", "to_space": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            "coordinate_space": "visium:Test_Section",
            "measured_entity": { "kind": "spot", "platform": "visium", "resolution_um": 55.0 },
            "component_columns": ["spatial_x", "spatial_y"],
        }),
        None,
    )
    .await;

    let f32_bytes = |v: &[f32]| -> Vec<u8> { v.iter().flat_map(|x| x.to_le_bytes()).collect() };
    let spatial_x = put_stored(
        &repo, &store, source, "column-spatial_x", "data/opaque",
        zarr_array_1d("values", "float32", 4, f32_bytes(&xs), None),
        one_d_structure("rows", N, "numeric", "float32", ROWS_DIGEST),
        json!({ "name": "spatial_x", "axis": "rows" }),
        None,
    )
    .await;
    let spatial_y = put_stored(
        &repo, &store, source, "column-spatial_y", "data/opaque",
        zarr_array_1d("values", "float32", 4, f32_bytes(&ys), None),
        one_d_structure("rows", N, "numeric", "float32", ROWS_DIGEST),
        json!({ "name": "spatial_y", "axis": "rows" }),
        None,
    )
    .await;

    // A post-filter COLOUR column — #157 scope item 3's "coloured by a post-filter
    // an ordinary column datatype". Codes cycle so the kept rows do not all land on one level.
    let codes: Vec<u8> = (0..N).map(|i| (i % 3) as u8).collect();
    let colour = put_stored(
        &repo, &store, source, "column-region", "data/opaque",
        zarr_array_1d("values", "uint8", 1, codes.clone(), Some(json!(["gl", "mcl", "gcl"]))),
        one_d_structure("rows", N, "categorical", "uint8", ROWS_DIGEST),
        json!({ "name": "region", "axis": "rows" }),
        None,
    )
    .await;

    let job_id = insert_running_job(&pool, owner, "analysis", Some(source)).await;
    sqlx::query("UPDATE jobs SET params = $2 WHERE id = $1")
        .bind(job_id)
        .bind(&json!({
            "language": "python",
            "script": "# the filter analysis (fabricated)\n",
            "inputs": [ { "slot": "expression", "artifact_ref": matrix } ],
        }))
        .execute(&pool)
        .await
        .expect("set job params");

    // The run-produced MARKED keep-mask, with real `bool` bytes.
    put_stored(
        &repo, &store, source, &format!("column-{LABEL}"), "data/opaque",
        zarr_array_1d("values", "bool", 1, KEEP.iter().map(|&k| k as u8).collect(), None),
        json!({
            "encoding": "zarr_v3", "kind": "table", "axis": "rows", "n": N,
            "columns": [{ "name": "values", "path": "values", "kind": "numeric",
                          "dtype": "bool", "shape": [N], "axis": "rows", "n": N }],
        }),
        json!({ "filter_mask": { "label": LABEL } }),
        Some(job_id),
    )
    .await;

    SpatialScene {
        pool, store, repo, owner, job_id,
        coordinates: coordinates_id, spatial_x, spatial_y, colour, matrix,
        aligned_to: ROWS_DIGEST.to_string(),
    }
}

async fn fetch_job(pool: &sqlx::SqlitePool, job_id: Uuid) -> cytoanalyst::modules::jobs::models::Job {
    cytoanalyst::modules::jobs::repository::JobRepository::new(pool.clone())
        .get_any(job_id)
        .await
        .expect("fetch job")
        .expect("job row")
}

/// The VD's gathered recipe row for one SOURCE artifact, or `None` if the sink minted none.
///
/// `fetch_all` + an explicit uniqueness assertion, NOT `fetch_optional`: the query carries no
/// `ORDER BY`, so if the sink ever minted two rows for one source, `fetch_optional` would hand
/// back an arbitrary one and every assertion in every test here would silently measure
/// whichever Postgres happened to return first. A duplicate mint must be a named failure.
async fn gathered_for(pool: &sqlx::SqlitePool, vd: Uuid, src: Uuid) -> Option<Uuid> {
    let src_s = src.to_string();
    let rows = sqlx::query_scalar!(
        "SELECT id as \"id: Uuid\" FROM artifacts WHERE dataset_id = $1 AND object_key IS NULL \
           AND structure -> 'gathered_from' -> 'sources' -> 0 ->> 'artifact_id' = $2",
        vd,
        src_s
    )
    .fetch_all(pool)
    .await
    .expect("query the gathered row");
    assert!(
        rows.len() <= 1,
        "the filter sink minted {} gathered rows for source {src} — every assertion in this \
         file addresses 'the' gathered row and would be measuring an arbitrary one",
        rows.len()
    );
    rows.into_iter().next()
}

async fn row_of(repo: &CatalogRepository, id: Uuid) -> (Value, Value) {
    let row = repo.get_any_status(id).await.expect("read artifact").expect("artifact row");
    (row.structure, row.meta)
}

/// Does this error say the store has no such MEMBER?
///
/// Measured, not guessed: a probe against this very fixture returned
/// `AppError { status_code: 404, error_code: "RESOURCE_NOT_FOUND", message: "Artifact member
/// not found" }`. Matched on the message text rather than the status because the staging path
/// wraps the error (`describe_artifact_staging_failure`) and only the message survives.
fn member_not_found(err: &ziee_core::AppError) -> bool {
    // The measured phrase, not the bare word `member`: `contains("member")` also matches
    // "members" and "remember", so it would stay green through a different gather failure —
    // and this predicate is the ATTRIBUTION step for the whole diagnosis below.
    format!("{err:?}").to_lowercase().contains("member not found")
}

/// **Does this staging error carry the `blob absent` REWRITE?**
///
/// `sandbox/inputs.rs::describe_artifact_staging_failure` rewrites ANY error whose status is
/// `BLOB_ABSENT_STATUS` (404) into a message about missing stored bytes — and a gather's
/// member-not-found IS a 404, so the member cause is erased on its way out.
///
/// For a GATHERED artifact that rewritten message is actively wrong, and it is worth naming as
/// its own small finding: it tells the operator the blob "is gone" and to "re-import or
/// re-produce this artifact (and check the server log for the object key)" — of an artifact
/// that by construction HAS no object key and whose sources are perfectly intact. Someone
/// following that advice would re-import a healthy dataset.
///
/// The tests below therefore assert the rewrite AND separately prove the underlying cause by
/// calling `gather_exec::resolve` directly, where the error is still legible. Asserting only
/// the rewrite would stay green through any other 404 in the staging path.
fn staging_blob_absent_rewrite(err: &ziee_core::AppError) -> bool {
    format!("{err:?}").contains("stored bytes are MISSING")
}

fn decode_f32(resolved: &ResolvedGather) -> Vec<f32> {
    let mut bytes = Vec::new();
    for g in 0..resolved.chunk_count() {
        bytes.extend_from_slice(&resolved.member(&format!("values/c/{g}")).unwrap().unwrap());
    }
    bytes.truncate(resolved.n * 4);
    bytes.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
}

fn decode_u8(resolved: &ResolvedGather) -> Vec<u8> {
    let mut bytes = Vec::new();
    for g in 0..resolved.chunk_count() {
        bytes.extend_from_slice(&resolved.member(&format!("values/c/{g}")).unwrap().unwrap());
    }
    bytes.truncate(resolved.n);
    bytes
}

async fn create_vd(scene: &SpatialScene) -> Uuid {
    let job = fetch_job(&scene.pool, scene.job_id).await;
    match create_filter_vd_for_run(&scene.pool, &job).await.expect("create the filter VD") {
        FilterOutcome::Created { dataset_id, .. } => dataset_id,
        other => panic!("the filter sink did not create a virtual dataset: {other:?}"),
    }
}

// ════════════════════════════════════════════════════════════════════════════════════════════
//  TEST-6 [acceptance] [invariant: INV-6] — what filtering carries, and how
// ════════════════════════════════════════════════════════════════════════════════════════════

/// **§9's question, answered: the filter analysis RE-EMITS every row-aligned sibling — as a gathered
/// row — rather than invalidating them.**
///
/// The design said it did not know which, and asked for a test. This is the answer:
/// `create_filter_vd_for_run` (`virtual_dataset.rs:1525`) walks `list_usable_by_dataset` and
/// mints ONE gathered artifact per source artifact whose `structure` it can classify, with the
/// row mask riding every artifact whose declared row count equals the mask's. Nothing is
/// invalidated and nothing is dropped.
#[tokio::test]
async fn a_filter_carries_every_row_aligned_spatial_sibling_into_the_virtual_dataset() {
    let server = TestServer::spawn().await;
    let scene = spatial_scene(&server, "Visium section").await;
    let vd = create_vd(&scene).await;

    for (label, src) in [
        ("the tissue map", scene.coordinates),
        ("spatial_x", scene.spatial_x),
        ("spatial_y", scene.spatial_y),
        ("the colour column", scene.colour),
        ("the counts matrix", scene.matrix),
    ] {
        let gathered = gathered_for(&scene.pool, vd, src).await;
        assert!(
            gathered.is_some(),
            "{label} was NOT carried into the filtered dataset. §9's fourth constraint is that \
             filtering must carry the spatial siblings; a source artifact with no gathered row \
             is one the filtered view cannot show at all"
        );
        let (structure, _meta) = row_of(&scene.repo, gathered.unwrap()).await;
        assert!(
            !structure["gathered_from"]["mask_artifact_id"].is_null(),
            "{label} was carried but the row mask does NOT ride it — it would show all {N} \
             source rows inside a filtered dataset"
        );
    }
}

/// **The `meta` — and therefore `component_columns` — survives the filter verbatim.**
///
/// This is the channel #154's Option A settlement bet on, and it is the reason the tissue map
/// is still renderable after a filter even though its own gathered row is not
/// (`a_filtered_visium_tissue_map_cannot_be_served_at_all`, below). Pinned separately from the
/// structure because they are copied by different code: `virtual_dataset.rs:1715-1722` clones
/// `s.meta` and only adds `definition_content_hash`, while `structure` is RE-MINTED.
#[tokio::test]
async fn the_coordinates_meta_survives_a_filter_verbatim_including_component_columns() {
    let server = TestServer::spawn().await;
    let scene = spatial_scene(&server, "Visium section").await;
    let vd = create_vd(&scene).await;

    let gathered = gathered_for(&scene.pool, vd, scene.coordinates)
        .await
        .expect("the coordinates row is gathered");
    let (_structure, meta) = row_of(&scene.repo, gathered).await;

    assert_eq!(
        meta["component_columns"],
        json!(["spatial_x", "spatial_y"]),
        "the producer's `component_columns` declaration did not survive the filter. It is \
         declared on `meta` precisely BECAUSE the gather re-mints `structure`, so losing it \
         here would leave the filtered tissue map offered-but-blank"
    );
    assert_eq!(meta["unit"], json!("pixel"));
    assert_eq!(meta["coordinate_space"], json!("visium:Test_Section"));
    assert_eq!(
        meta["measured_entity"]["kind"], json!("spot"),
        "§15.1's `measured_entity` must survive a filter — it is the only record of what one \
         row IS, and it is unrecoverable from the bytes afterwards"
    );
    assert!(
        !meta["definition_content_hash"].is_null(),
        "a gathered row owns no bytes to hash, so the deterministic definition hash is what \
         makes its `immutable` header honest"
    );
}

/// **INV-6's actual answer, and it is NOT the one §9 assumed: `aligned_to` does NOT survive a
/// filter. Neither does `memberships`.**
///
/// §9 says the carrying mechanism is that "the coordinates artifact is `row-aligned` with
/// `aligned_to` + `membership` … So the mechanism exists and is the one already used for
/// reduced layouts." The OUTCOME it predicts is right — the siblings are carried (test above) — but
/// the MECHANISM is not `aligned_to`. It is gathering, and gathering deliberately drops the
/// alignment identity:
///
/// * `virtual_dataset.rs:1690` passes `KeyIdentity::Unpinned` on the filter path, with the
///   stated reason *"A filter carries no alignment digest, so the identity is Unpinned — a
///   masked key sequence has a digest nobody computed"*;
/// * `gathered_structure`'s match (`:617-621`) emits `key_sequence_digest` for `Carries`,
///   `aligned_to` for `AlignedTo`, and **nothing at all** for `Unpinned`;
/// * `memberships` is not in the minted structure's vocabulary at all.
///
/// That is a defensible design — inventing a digest for a masked key sequence would be a
/// fabricated identity, and `verify_leaf_digest`'s whole contract is that unknown never matches
/// — but it is not what §9 says, and a downstream consumer that tried to re-align a filtered
/// sibling by digest would find nothing to match on. Pinned here so the design and the tree can
/// be reconciled deliberately rather than discovered by whoever needs it next.
#[tokio::test]
async fn a_gathered_sibling_declares_no_alignment_identity_at_all() {
    let server = TestServer::spawn().await;
    let scene = spatial_scene(&server, "Visium section").await;
    let vd = create_vd(&scene).await;

    for (label, src) in [
        ("the tissue map", scene.coordinates),
        ("spatial_x", scene.spatial_x),
        ("the colour column", scene.colour),
    ] {
        let gathered = gathered_for(&scene.pool, vd, src).await.expect("gathered");
        let (source_structure, _) = row_of(&scene.repo, src).await;
        assert_eq!(
            source_structure["aligned_to"], json!(scene.aligned_to),
            "{label}'s SOURCE must carry `aligned_to`, or this test proves nothing about \
             whether the filter dropped it"
        );

        let (structure, _) = row_of(&scene.repo, gathered).await;
        assert!(
            structure["aligned_to"].is_null(),
            "{label}: `aligned_to` SURVIVED the filter. That is not what \
             `virtual_dataset.rs:1690` (`KeyIdentity::Unpinned`) does today; if the filter path \
             now pins an identity, §9's stated mechanism has become true and this test must be \
             re-derived against it rather than relaxed"
        );
        assert!(
            structure["key_sequence_digest"].is_null(),
            "{label}: a gathered row must not claim to CARRY an axis it only lives on"
        );
        assert!(
            structure["memberships"].is_null(),
            "{label}: `memberships` is not in the gathered structure's vocabulary; §9 names it \
             as half the carrying mechanism"
        );
    }
}

/// **The Option A siblings serve the KEPT rows' real coordinates — the tissue map survives a
/// filter, through the 1-D columns rather than through the 2-D member.**
///
/// #157 scope item 3, at the bytes. `spatial_x` and `spatial_y` are ordinary 1-D `float32`
/// columns whose member IS called `values`, so nothing about them is special to the gather —
/// which is exactly why #154 emitted them.
#[tokio::test]
async fn the_option_a_siblings_serve_the_kept_spots_coordinates() {
    let server = TestServer::spawn().await;
    let scene = spatial_scene(&server, "Visium section").await;
    let vd = create_vd(&scene).await;

    let coords = coordinates();
    let xs: Vec<f32> = coords.iter().map(|c| c[0]).collect();
    let ys: Vec<f32> = coords.iter().map(|c| c[1]).collect();

    for (label, src, expected) in [
        ("spatial_x", scene.spatial_x, kept(&xs)),
        ("spatial_y", scene.spatial_y, kept(&ys)),
    ] {
        let gathered = gathered_for(&scene.pool, vd, src).await.expect("gathered");
        let (structure, _) = row_of(&scene.repo, gathered).await;
        let resolved = resolve(&scene.pool, &scene.store, gathered, &structure)
            .await
            .unwrap_or_else(|e| panic!("{label} failed to resolve: {e:?}"));

        assert_eq!(resolved.n, KEPT_ROWS.len(), "{label} served the wrong row count");
        assert_eq!(
            decode_f32(&resolved), expected,
            "{label} did not serve the kept spots' values in kept order"
        );
    }
}

/// **A post-filter colour column serves the kept rows' codes AND keeps its level vocabulary.**
///
/// The other half of #157 scope item 3 — its "post-filter" colour column (the issue's own noun for it
/// is a datatype name this file does not spell). A
/// categorical whose codes survived but whose `levels` did not would render as integers.
#[tokio::test]
async fn a_post_filter_colour_column_serves_kept_codes_with_its_levels() {
    let server = TestServer::spawn().await;
    let scene = spatial_scene(&server, "Visium section").await;
    let vd = create_vd(&scene).await;

    let codes: Vec<u8> = (0..N).map(|i| (i % 3) as u8).collect();
    let gathered = gathered_for(&scene.pool, vd, scene.colour).await.expect("gathered");
    let (structure, _) = row_of(&scene.repo, gathered).await;
    let resolved = resolve(&scene.pool, &scene.store, gathered, &structure)
        .await
        .expect("the colour column resolves");

    assert_eq!(decode_u8(&resolved), kept(&codes));
    let levels: Value = serde_json::from_slice(
        &resolved.member("values/zarr.json").unwrap().unwrap(),
    )
    .map(|v: Value| v["attributes"]["cyto"]["levels"].clone())
    .expect("the served member's zarr.json");
    assert_eq!(
        levels, json!(["gl", "mcl", "gcl"]),
        "the level vocabulary did not survive the filter; the filtered tissue map would be \
         coloured by raw integer codes"
    );
    assert!(
        decode_u8(&resolved).iter().collect::<std::collections::HashSet<_>>().len() > 1,
        "the SERVED codes are all one value, so this test could not tell a correct gather from \
         one that served a constant. (Asserted on the served bytes, not on the fixture's own \
         `codes` — the fixture version was evaluated entirely over compile-time constants and \
         could never fail for any product state.)"
    );
}

/// **The SHIPPED Visium tissue map cannot be served AT ALL after a filter — and that is the
/// better of #203's two failure modes.**
///
/// #203's headline is that a 2-D row-aligned artifact through a filter VD serves *plausible
/// wrong numbers* rather than an error. That is measured in `filter_vd_test.rs` §P2 — over a
/// fixture whose 2-D member is named `values`.
///
/// The real importer names its member `coordinates`. `gathered_structure` hardcodes
/// `column_selector: SOURCE_MEMBER` (`virtual_dataset.rs:180`, `"values"`), so for the artifact
/// this epic actually produces the recipe addresses a member the store does not contain, and
/// the resolve FAILS instead of quietly interleaving. Loud beats silent: this is the case
/// where a user sees an error rather than a plausible-looking picture of the wrong tissue.
///
/// **This asserts a DEFECT, not a contract.** It is expected to change when #203 lands, and
/// whoever lands it should re-derive this test against the fixed behaviour — the value being
/// pinned is "the shipped Visium shape is in the LOUD arm of #203", which is the fact that
/// decides how urgent #203 is for this epic.
#[tokio::test]
async fn a_filtered_visium_tissue_map_cannot_be_served_at_all() {
    let server = TestServer::spawn().await;
    let scene = spatial_scene(&server, "Visium section").await;
    let vd = create_vd(&scene).await;

    let gathered = gathered_for(&scene.pool, vd, scene.coordinates)
        .await
        .expect("the coordinates row IS gathered — it is the SERVE that fails, not the mint");
    let (structure, _) = row_of(&scene.repo, gathered).await;

    // The re-minted declaration, first: this is #203's mechanism, in the shipped shape.
    assert_eq!(
        structure["columns"][0]["path"], json!("values"),
        "DEFECT (#203): the gathered recipe addresses the member `values`, but the source \
         store's only member is `{COORDINATES_MEMBER}` (`virtual_dataset.rs:180` hardcodes \
         `SOURCE_MEMBER`)"
    );
    assert_eq!(
        structure["gathered_from"]["column_selector"], json!("values"),
        "DEFECT (#203): the recipe's `column_selector` is the same hardcoded constant"
    );
    assert_eq!(
        structure["columns"][0]["shape"].as_array().map(|a| a.len()), Some(1),
        "DEFECT (#203): the source's width (2) is DROPPED — the gathered row declares a 1-D \
         member, so `declaredComponentCount` reads nothing and the tissue map is not offered"
    );
    assert_eq!(
        structure["arrays"], json!([]),
        "DEFECT (#203): `arrays` — the only place a >=2-D member can be declared — is emptied"
    );

    // …and then what actually happens when something tries to READ it.
    let err = resolve(&scene.pool, &scene.store, gathered, &structure)
        .await
        .err()
        .expect(
            "the filtered Visium coordinates artifact RESOLVED. Its member is named \
             `coordinates` while the recipe asks for `values`, so a successful resolve means \
             either #203 has been fixed (re-derive this test against the correct served \
             coordinates) or the gather has started serving SOMETHING for a member it was not \
             asked for — which would be strictly worse than today's error",
        );
    assert!(
        member_not_found(&err),
        "the resolve failed, but NOT with a member-not-found error: {err:?}. Measured today it \
         is `RESOURCE_NOT_FOUND / \"Artifact member not found\"`. `is_err()` alone would stay \
         green through an unrelated breakage of the gather path, and this measurement would \
         silently stop being about #203"
    );
}

// ════════════════════════════════════════════════════════════════════════════════════════════
//  TEST-10 + TEST-18 — what a SANDBOXED analysis receives for a filtered sibling, and the
//  member NAME that decides between #203's two failure modes
// ════════════════════════════════════════════════════════════════════════════════════════════

/// **A filtered sibling reaches a sandboxed analysis through the SAME gather the browser reads
/// — so #203 is not a browser-only defect.**
///
/// `sandbox/inputs.rs:720-743`: an artifact with `object_key IS NULL` — which is exactly what a
/// gathered filter-VD row is — is MATERIALISED into the sandbox inputs dir through
/// `gather_exec::resolve` + `ResolvedGather::materialize`, the same resolution and the same
/// assembly the HTTP byte route serves. There is no fallback to the source store.
///
/// Two consequences, both asserted: the Option-A sibling arrives on disk carrying the KEPT
/// rows' values (so the chain a Python analysis would run on a filtered spatial dataset sees
/// correct coordinates through the 1-D columns), and the 2-D tissue map cannot be staged at all
/// — the job fails at staging rather than handing a compute interleaved numbers.
#[tokio::test]
async fn a_filtered_sibling_materialises_into_the_sandbox_and_the_tissue_map_does_not() {
    let server = TestServer::spawn().await;
    let scene = spatial_scene(&server, "Visium section").await;
    let vd = create_vd(&scene).await;

    let sibling = gathered_for(&scene.pool, vd, scene.spatial_x).await.expect("gathered x");
    let tissue_map = gathered_for(&scene.pool, vd, scene.coordinates).await.expect("gathered map");

    let workspace = server.data_dir().join("sandboxes").join(Uuid::new_v4().to_string());
    let allowlist: Vec<PathBuf> = Vec::new();

    // ── the sibling stages, and its bytes are the kept rows ────────────────────────────
    let spec = AnalysisSpec::parse(&json!({
        "language": "python", "script": "print(1)",
        "inputs": [ { "slot": "column:spatial_x", "artifact_ref": sibling } ],
    }))
    .expect("spec parses");
    let inputs_dir = workspace.join("ok").join("inputs");
    let staged = materialize_inputs(&spec, &inputs_dir, scene.owner, &allowlist, &scene.pool, &scene.store)
        .await
        .expect("a gathered 1-D sibling must materialise into the sandbox");
    assert_eq!(staged.len(), 1);
    assert_eq!(
        staged[0].kind, "artifact-gathered",
        "a filter-VD row owns no blob, so it must arrive by the GATHERED path — if it arrived \
         as `artifact-prefix` it was read from the unfiltered source store and the sandbox and \
         the browser are no longer reading one gather"
    );

    let root: Value = serde_json::from_slice(
        &std::fs::read(staged[0].host_path.join("zarr.json")).expect("materialised zarr.json"),
    )
    .expect("parse the materialised root");
    assert_eq!(
        root["attributes"]["cyto"]["n"], json!(KEPT_ROWS.len()),
        "the materialised store declares {N} rows, not the {} kept — a sandboxed analysis \
         would read the UNFILTERED column",
        KEPT_ROWS.len()
    );
    assert!(
        root["attributes"]["cyto"]["aligned_to"].is_null(),
        "#211 + the Unpinned filter identity: what a sandboxed consumer can see of a filtered \
         sibling is the RE-MINTED structure, which carries no alignment digest. If that changes, \
         `a_gathered_sibling_declares_no_alignment_identity_at_all` must change with it"
    );

    // ── the tissue map does NOT stage, and the failure is loud ─────────────────────────
    let bad_spec = AnalysisSpec::parse(&json!({
        "language": "python", "script": "print(1)",
        "inputs": [ { "slot": "coordinates", "artifact_ref": tissue_map } ],
    }))
    .expect("spec parses");
    let bad_dir = workspace.join("bad").join("inputs");
    let err = materialize_inputs(&bad_spec, &bad_dir, scene.owner, &allowlist, &scene.pool, &scene.store)
        .await
        .err()
        .expect(
            "DEFECT (#203) — the filtered 2-D tissue map STAGED into a sandbox. Its recipe asks \
             for a member named `values` that the store does not have, so a success here means a \
             compute would be handed bytes nobody asked for. Today it fails, loudly, which is \
             the correct behaviour in the presence of the defect",
        );
    assert!(
        staging_blob_absent_rewrite(&err),
        "staging failed, but not with the blob-absent rewrite: {err:?}"
    );

    // …and the ATTRIBUTION, because the rewrite above erased it. Resolving the same gathered
    // row directly shows the real cause, which is the member the recipe named and the store
    // does not have. Without this line the staging assertion would stay green through any
    // other 404 in the staging path and would stop being a measurement of #203.
    let (tissue_structure, _) = row_of(&scene.repo, tissue_map).await;
    let direct = resolve(&scene.pool, &scene.store, tissue_map, &tissue_structure)
        .await
        .err()
        .expect("the same row must also fail to resolve directly");
    assert!(
        member_not_found(&direct),
        "the direct resolve failed for a reason other than a missing member: {direct:?}"
    );
}

/// **TEST-18 — the member NAME is the switch between #203's loud arm and its silent one,
/// and the shipped importer is on the loud side.**
///
/// This is the fact that decides how urgent #203 is for the spatial epic, and nothing in the
/// tree stated it. Both halves are measured here, on the same real coordinates structure, with
/// exactly one variable changed: what the 2-D member is called.
///
/// * member named **`coordinates`** (what `write_spatial_coordinates` actually writes) — the
///   recipe's hardcoded `column_selector: "values"` (`virtual_dataset.rs:180`) addresses a
///   member the store does not contain, and the resolve returns member-not-found. The user
///   sees an error.
/// * member named **`values`** — the resolve SUCCEEDS and serves the row mask applied to the
///   INTERLEAVED buffer. With spot `i` at `(100 + 10i, 5000 + i)` and rows `{0,3,6,7}` kept it
///   serves `[100.0, 5001.0, 130.0, 5003.0]`: neither the kept x's (`[100,130,160,170]`) nor
///   the kept y's (`[5000,5003,5006,5007]`), but `flatten(coords)` masked as if it were one
///   value per row — one component from each of four different spots.
///
/// The two components are three orders of magnitude apart on purpose: the served vector
/// visibly alternates between the x scale and the y scale, so the interleaving cannot be
/// mistaken for a plausible coordinate list.
///
/// **This asserts a DEFECT.** Whoever fixes #203 should expect BOTH arms to change and should
/// re-derive against the corrected behaviour — the value pinned here is the CONTRAST.
#[tokio::test]
async fn the_member_name_is_the_switch_between_a_loud_and_a_silent_filter() {
    let coords = coordinates();
    let flat: Vec<f32> = coords.iter().flat_map(|xy| xy.iter().copied()).collect();
    let interleaved_prefix: Vec<f32> = flat.iter().copied().take(N).collect();
    let expected_silent = kept(&interleaved_prefix);
    let kept_xs = kept(&coords.iter().map(|c| c[0]).collect::<Vec<f32>>());
    let kept_ys = kept(&coords.iter().map(|c| c[1]).collect::<Vec<f32>>());

    // ── the SHIPPED name: loud ─────────────────────────────────────────────────────────
    {
        let server = TestServer::spawn().await;
        let scene = spatial_scene_named(&server, "loud arm", COORDINATES_MEMBER).await;
        let vd = create_vd(&scene).await;
        let g = gathered_for(&scene.pool, vd, scene.coordinates).await.expect("gathered");
        let (structure, _) = row_of(&scene.repo, g).await;
        let err = resolve(&scene.pool, &scene.store, g, &structure)
            .await
            .err()
            .expect("the shipped member name is `coordinates`; the recipe asks for `values`");
        assert!(member_not_found(&err), "failed for the wrong reason: {err:?}");
    }

    // ── the same artifact, member renamed: silent, and wrong ───────────────────────────
    {
        let server = TestServer::spawn().await;
        let scene = spatial_scene_named(&server, "silent arm", "values").await;
        let vd = create_vd(&scene).await;
        let g = gathered_for(&scene.pool, vd, scene.coordinates).await.expect("gathered");
        let (structure, _) = row_of(&scene.repo, g).await;
        let resolved = resolve(&scene.pool, &scene.store, g, &structure).await.expect(
            "DEFECT (#203): with the member named `values` the gather resolves happily. If it \
             now REFUSES, #203 has been fixed or hardened and this whole test must be re-derived",
        );
        assert_eq!(
            resolved.n,
            KEPT_ROWS.len(),
            "DEFECT (#203): the served length is PLAUSIBLE — the row count is right, which is \
             precisely why the wrong values below are silent. `GATHER_MASK_LENGTH_MISMATCH` \
             cannot fire, because the decoder already truncated the [n, 2] array to its first n \
             elements (`gather_decode.rs` `dim0` reads `shape[0]` only)"
        );
        let got = decode_f32(&resolved);
        assert_eq!(
            got, expected_silent,
            "DEFECT (#203): the served values must be the row mask applied to the INTERLEAVED \
             buffer"
        );
        assert_ne!(got, kept_xs, "the served values are not the kept spots' x coordinates");
        assert_ne!(got, kept_ys, "the served values are not the kept spots' y coordinates");
    }
}

// ════════════════════════════════════════════════════════════════════════════════════════════
//  TEST-19 — does the CHAIN cross the filter? What a downstream analysis receives for the
//  filtered MATRIX itself.
//
//  (TEST-14, the chain's CONTINUATION on the filtered population, is the Python half's — it
//  runs the shipped analyses. This is the half that measures what the platform hands them.)
// ════════════════════════════════════════════════════════════════════════════════════════════
//
// #157's scope item 1 states the chain as import -> filter -> reduce -> cluster -> compare,
// and that arrow after the filter analysis is the one this file has to answer, because the Python
// suite cannot: the filter analysis's compute emits only a keep-mask, and the filtered matrix a
// downstream analysis consumes is minted SERVER-SIDE.
//
// Which mechanism delivers it was traced rather than assumed. There are two candidates and only
// one is live:
//
//   (A) `resolve_vd_compute_inputs` (`virtual_dataset.rs:1782`) returns `{mask, alignment,
//       sources}` where the sources are the SOURCE dataset's own STORED artifacts, i.e. the
//       compute would receive the UNFILTERED matrix plus a mask and apply it itself. It has
//       **no production caller** — the only call site in the repository is a test — and **no
//       shipped analysis declares a `mask` slot** for its mask to be bound to. It is dead code.
//   (B) the client binds the GATHERED (already row-filtered) artifact as an ordinary
//       `artifact_ref`, and `sandbox/inputs.rs:720` materialises it because its `object_key`
//       is NULL. This is the live path.
//
// So the question is exactly: does the gathered MATRIX materialise into a store the next
// analysis can read? Measured below rather than reasoned about.

/// One 1-D zarr member for a CSC part, at its own dtype.
fn csc_member(prefix: &str, dtype: &str, item: usize, elems: Vec<u8>) -> Vec<(String, Vec<u8>)> {
    zarr_array_1d(prefix, dtype, item, elems, None)
}

/// A REAL `sparse_csc` counts store — the shape the importer emits, with bytes.
///
/// Compressed along the SECOND axis (so `indptr` spans second-axis + 1 and `indices` holds
/// row positions). That is the LAYOUT `cyto_csc.write_csc_zarr` produces — whatever axis
/// names its caller passes; the shipped importers pass their own domain axes, and the names
/// here are this file's shape-named stand-ins. What every consumer in the chain narrows on is
/// `structure.kind == "sparse_csc"`, which is reproduced exactly.
async fn put_stored_counts(
    repo: &CatalogRepository,
    store: &dyn ObjectStore,
    dataset: Uuid,
    n_rows: usize,
    n_cols: usize,
) -> Uuid {
    let mut data: Vec<f32> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    let mut indptr: Vec<i64> = vec![0];
    for g in 0..n_cols {
        for c in 0..n_rows {
            // A deterministic, integer-valued, non-degenerate count. The reducer
            // REFUSES a matrix whose stored values are not whole numbers, and a constant
            // matrix would give a rank-0 PCA.
            let v = ((c * 7 + g * 13) % 11) as f32 + 1.0;
            indices.push(c as u32);
            data.push(v);
        }
        indptr.push(data.len() as i64);
    }
    let nnz = data.len();
    let structure = json!({
        "encoding": "zarr_v3", "kind": "sparse_csc",
        "axes": ["rows", "cols"], "shape": [n_rows, n_cols], "nnz": nnz,
        "indptr":  { "path": "indptr",  "kind": "numeric", "dtype": "int64",
                     "shape": [n_cols + 1] },
        "indices": { "path": "indices", "kind": "numeric", "dtype": "uint32",
                     "shape": [nnz] },
        "data":    { "path": "data",    "kind": "numeric", "dtype": "float32",
                     "shape": [nnz] },
    });

    // The ROOT GROUP NODE. Not optional and not decoration: `_lib/cyto_csc.py`'s
    // `write_csc_zarr` ends by writing this same node — abridged here, since the per-member
    // geometry keys a real writer adds (`inner_chunk`, `chunks_per_shard`, `shards`,
    // `stored_bytes`) are read by nothing in this path — and `attributes.cyto` in it IS the
    // structure every shipped reader deserializes. A fixture with the three member arrays and
    // no group node is not a store any consumer can open — which would make the POSITIVE
    // CONTROL below ("the unfiltered matrix stages fine, so the fixture is real") a weaker
    // claim than its message makes.
    let mut members: Vec<(String, Vec<u8>)> = vec![(
        "zarr.json".to_string(),
        serde_json::to_vec(&json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": { "cyto": structure.clone() },
        }))
        .expect("root group meta"),
    )];
    members.extend(csc_member(
        "data", "float32", 4, data.iter().flat_map(|v| v.to_le_bytes()).collect()));
    members.extend(csc_member(
        "indices", "uint32", 4, indices.iter().flat_map(|v| v.to_le_bytes()).collect()));
    members.extend(csc_member(
        "indptr", "int64", 8, indptr.iter().flat_map(|v| v.to_le_bytes()).collect()));

    put_stored(
        repo, store, dataset, "expression", "data/opaque", members, structure,
        json!({ "kind": "counts", "platform": "visium" }),
        None,
    )
    .await
}

/// **TEST-19 — what a downstream analysis actually receives for the FILTERED matrix.**
///
/// The gathered counts matrix is bound as an ordinary `artifact_ref` (mechanism B, the live
/// one) and put through the production `sandbox::inputs::materialize_inputs`. Whatever happens
/// is what happens to the second half of #157's chain, and it is asserted rather than assumed.
///
/// This test is written to record EITHER outcome truthfully: if the matrix materialises, the
/// materialised store must be a readable `sparse_csc` over the KEPT rows (and the test says
/// so); if it does not, the failure must be the member-not-found one, and the test states
/// plainly that the post-filter half of the chain is unreachable today. It asserts what the
/// tree does, and names which of the two it observed in the failure message either way.
#[tokio::test]
async fn what_a_downstream_analysis_receives_for_the_filtered_matrix() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let owner = admin_user_id(&pool).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);
    let source: Uuid = create_dataset(&server, &token, "Visium counts").await.parse().unwrap();

    // A real matrix with real bytes — 24 spots so a post-filter analysis would clear
    // the reducer's viable-row floor of 10 with room to spare.
    let n_rows = 24usize;
    let n_cols = 12usize;
    let matrix = put_stored_counts(&repo, &store, source, n_rows, n_cols).await;

    // Keep 16 of 24, in a pattern that is neither a prefix nor contiguous.
    let keep: Vec<bool> = (0..n_rows).map(|i| i % 3 != 2).collect();
    let n_kept = keep.iter().filter(|k| **k).count();
    assert_eq!(n_kept, 16, "the fixture's own arithmetic");

    let job_id = insert_running_job(&pool, owner, "analysis", Some(source)).await;
    sqlx::query("UPDATE jobs SET params = $2 WHERE id = $1")
        .bind(job_id)
        .bind(&json!({
            "language": "python", "script": "# the filter analysis (fabricated)\n",
            "inputs": [ { "slot": "expression", "artifact_ref": matrix } ],
        }))
        .execute(&pool)
        .await
        .expect("set job params");
    put_stored(
        &repo, &store, source, &format!("column-{LABEL}"), "data/opaque",
        zarr_array_1d("values", "bool", 1, keep.iter().map(|&k| k as u8).collect(), None),
        json!({
            "encoding": "zarr_v3", "kind": "table", "axis": "rows", "n": n_rows,
            "columns": [{ "name": "values", "path": "values", "kind": "numeric",
                          "dtype": "bool", "shape": [n_rows], "axis": "rows", "n": n_rows }],
        }),
        json!({ "filter_mask": { "label": LABEL } }),
        Some(job_id),
    )
    .await;

    let job = fetch_job(&pool, job_id).await;
    let vd = match create_filter_vd_for_run(&pool, &job).await.expect("create the filter VD") {
        FilterOutcome::Created { dataset_id, .. } => dataset_id,
        other => panic!("the filter sink did not create a virtual dataset: {other:?}"),
    };

    // The matrix IS carried, with the mask riding it — that much is catalog state.
    let gathered = gathered_for(&pool, vd, matrix)
        .await
        .expect("the counts matrix must be carried into the filtered dataset");
    let (structure, _) = row_of(&repo, gathered).await;
    assert_eq!(
        structure["kind"], json!("sparse_csc"),
        "a gathered MATRIX keeps its own declaration (only the recipe is injected), unlike a \
         gathered column whose structure is re-minted"
    );
    assert!(!structure["gathered_from"]["mask_artifact_id"].is_null());

    // ── the measurement: can it be STAGED for the next analysis? ───────────────────────
    let spec = AnalysisSpec::parse(&json!({
        "language": "python", "script": "print(1)",
        "inputs": [ { "slot": "matrices", "artifact_ref": gathered } ],
    }))
    .expect("spec parses");
    let inputs_dir = server
        .data_dir()
        .join("sandboxes")
        .join(Uuid::new_v4().to_string())
        .join("inputs");
    let allowlist: Vec<PathBuf> = Vec::new();
    let staged = materialize_inputs(&spec, &inputs_dir, owner, &allowlist, &pool, &store).await;

    match staged {
        Ok(mounts) => {
            // The chain CROSSES the filter. Then the store handed to the next analysis must
            // be a real, readable, row-filtered CSC — a directory that exists is not enough.
            assert_eq!(mounts.len(), 1);
            assert_eq!(
                mounts[0].kind, "artifact-gathered",
                "the filtered matrix arrived by the STORED path, i.e. it was read from the \
                 unfiltered source — the analysis would silently see all {n_rows} rows"
            );
            let root: Value = serde_json::from_slice(
                &std::fs::read(mounts[0].host_path.join("zarr.json"))
                    .expect("the materialised store must have a root zarr.json"),
            )
            .expect("parse the materialised root");
            let cyto = &root["attributes"]["cyto"];
            assert_eq!(cyto["kind"], json!("sparse_csc"));
            assert_eq!(
                cyto["shape"][0], json!(n_kept),
                "the materialised matrix declares {} rows, not the {n_kept} kept — a downstream \
                 analysis would run on the UNFILTERED population",
                cyto["shape"][0]
            );
            assert_eq!(cyto["axes"], json!(["rows", "cols"]));
            assert!(
                !cyto["nnz"].is_null(),
                "the materialised store declares no `nnz`; the reducer and both inference \
                 entries refuse BY NAME on a missing nnz before reading a byte, so the chain \
                 would stop here with a valid-looking matrix"
            );
            for member in ["data", "indices", "indptr"] {
                assert!(
                    mounts[0].host_path.join(member).join("zarr.json").is_file(),
                    "the materialised store is missing the `{member}` member a CSC reader needs"
                );
            }
        }
        Err(err) => {
            // ── MEASURED: the chain STOPS at the filter. ──────────────────────────────
            //
            // This is the same mechanism as #203's coordinates case, one artifact over.
            // `gather_exec::resolve` reads `recipe.column_selector`, which
            // `gathered_structure` hardcodes to the literal `SOURCE_MEMBER` = `"values"`
            // (`virtual_dataset.rs:180`) — and `resolve` has no `sparse_csc` branch at all
            // (the string does not occur in `gather_exec.rs` outside one doc comment). A CSC
            // store's members are `data` / `indices` / `indptr`, so the recipe addresses a
            // member that is not there.
            //
            // The consequence is NOT spatial. It is that a downstream analysis cannot be run
            // against ANY filter virtual dataset's matrix — the filtered dataset can be
            // created, listed and offered by the picker, and the job then fails at input
            // staging. The masked SPARSE serve that does exist
            // (`gather_exec::resolve_masked_sparse_column`) is a per-column WIRE protocol for
            // the browser; nothing composes it into a materialisable store.
            //
            // Pinned as the current behaviour rather than left as a panic, so that the day it
            // is fixed this test goes RED and is re-derived against a working chain.
            assert!(
                staging_blob_absent_rewrite(&err),
                "staging the filtered matrix failed for an unexpected reason: {err:?}"
            );
            let direct = resolve(&pool, &store, gathered, &structure)
                .await
                .err()
                .expect("the gathered matrix must also fail to resolve directly");
            assert!(
                member_not_found(&direct),
                "the filtered matrix failed to resolve, but NOT because a member is missing: \
                 {direct:?}. That would mean the cause is something other than the hardcoded \
                 `column_selector`, and this whole diagnosis must be re-derived"
            );

            // The POSITIVE CONTROL that makes the negative result attributable, driven through
            // the SAME production entry point: the UNFILTERED matrix stages fine. Without it,
            // "the filtered matrix cannot be staged" is indistinguishable from "this fixture
            // never wrote any bytes" or "materialize_inputs is broken for everything".
            let control_spec = AnalysisSpec::parse(&json!({
                "language": "python", "script": "print(1)",
                "inputs": [ { "slot": "matrices", "artifact_ref": matrix } ],
            }))
            .expect("spec parses");
            let control_dir = server
                .data_dir()
                .join("sandboxes")
                .join(Uuid::new_v4().to_string())
                .join("inputs");
            let control = materialize_inputs(
                &control_spec, &control_dir, owner, &allowlist, &pool, &store)
                .await
                .expect(
                    "the UNFILTERED source matrix must stage — if it does not, the fixture's \
                     bytes or the staging path itself are broken and the filtered-matrix \
                     failure above is not attributable to the gather",
                );
            assert_eq!(control[0].kind, "artifact-prefix");
            assert!(
                control[0].host_path.join("zarr.json").is_file(),
                "the staged SOURCE store has no root group node, so it is not a store any \
                 shipped reader can open and the control proves less than it says"
            );
            for member in ["data", "indices", "indptr"] {
                assert!(
                    control[0].host_path.join(member).join("zarr.json").is_file(),
                    "the staged SOURCE matrix is missing its `{member}` member, so the fixture \
                     is not a readable CSC store and proves nothing"
                );
            }
        }
    }
}
