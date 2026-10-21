//! **ITEM-13 / ITEM-14 — a filter run MINTS a virtual dataset, and a compute against it
//! receives `(mask, alignment)` (§11.3 / §3.5).**
//!
//! These drive the finalize sink's filter path (`create_filter_vd_for_run`) DIRECTLY, with a
//! fabricated run + a produced marked keep-mask, rather than through a real filter sandbox
//! run — the creation logic is what is under test, and a real run is `creator_real_run_test`'s
//! (rootfs-gated) concern for the alignment mirror. The tests down to the P1 section serve NO
//! bytes, so their source columns carry placeholder `object_key`s: the catalog SHAPE
//! (source='filter', mask hidden + recording its source, gathered recipe rows, the delete cascade,
//! the compute-input set) is what each measures, and those are database facts. The **P2 section at
//! the foot of this file DOES serve bytes** — it builds REAL zarr stores + a REAL `bool` mask and
//! drives `gather_exec::resolve` over the very rows `create_filter_vd_for_run` minted, because
//! "the filtered column holds the kept rows' values" is not a database fact and cannot be asserted
//! from the catalog.
//!
//! Coverage:
//! * `a_filter_run_creates_a_filter_virtual_dataset` — TEST-36 (integration side): VD
//!   `source='filter'`, NAMED from the run label (DEC-6), mask hidden + role='mask' + recording
//!   its source (§3.4), source dataset unchanged; on-axis columns ride the mask, an off-axis
//!   (col) column is an identity passthrough (INV-1).
//! * `a_filter_virtual_dataset_costs_no_stored_bytes` — TEST-33 / INV-33.
//! * `deleting_a_filter_vd_cascades_its_mask_and_columns_but_not_the_source` — TEST-38.
//! * `a_compute_against_a_filter_vd_receives_the_mask_and_no_merged_matrix` — TEST-32 / INV-32.
//! * P2 (ITEM-14 / TEST-9, the #183 settlement's premises):
//!   `a_two_dimensional_source_is_gathered_as_a_one_dimensional_column` and
//!   `a_two_dimensional_member_named_values_serves_flattened_rows_not_coordinates` — the
//!   EXECUTABLE form of the defect #203 owns; `the_option_a_siblings_serve_the_kept_rows_values`
//!   and `a_post_filter_colour_column_serves_the_kept_rows_codes_and_levels` — the Option A
//!   premise, proven at the bytes.

use serde_json::{json, Value};
use uuid::Uuid;

use cytoanalyst::modules::workstore::catalog::models::NewArtifact;
use cytoanalyst::modules::workstore::catalog::repository::CatalogRepository;
use cytoanalyst::modules::workstore::gather_exec::{resolve, ResolvedGather};
use cytoanalyst::modules::workstore::mask::{mask_source_dataset_ids, MASK_ROLE};
use cytoanalyst::modules::workstore::object_store::{LocalFsStore, ObjectStore};
use cytoanalyst::modules::workstore::virtual_dataset::{
    create_filter_vd_for_run, resolve_vd_compute_inputs, FilterOutcome, DATASET_SOURCE_FILTER,
};

use crate::dataset::create_dataset;
use crate::dataset::hardening_common::{admin_user_id, insert_running_job};

use super::{pool_for, server_store, setup_admin};
use crate::common::TestServer;

const N_ROWS: usize = 6;
const N_COLS: usize = 4;
const LABEL: &str = "Kept high-quality";

/// A placeholder object key for a source column — a stored artifact (`object_key` present) with
/// no bytes actually in the store; these tests never serve it.
fn key() -> String {
    format!("sha256:{}", Uuid::new_v4().simple())
}

/// Insert one STORED source column artifact owned by `dataset`, returning its id.
async fn put_source_column(
    repo: &CatalogRepository,
    dataset: Uuid,
    output_id: &str,
    axis: &str,
    n: usize,
    kind: &str,
    dtype: &str,
) -> Uuid {
    let k = key();
    repo.insert_artifact(&NewArtifact {
        project_id: None,
        dataset_id: Some(dataset),
        run_id: None,
        output_id: output_id.into(),
        datatype: "data/opaque".into(),
        object_key: Some(k.clone()),
        is_multifile: true,
        content_hash: k,
        structure: json!({
            "encoding": "zarr_v3", "kind": "table", "axis": axis, "n": n,
            "columns": [{ "name": "values", "path": "values", "kind": kind,
                          "dtype": dtype, "shape": [n], "axis": axis, "n": n }],
            "arrays": [],
        }),
        meta: json!({ "display_name": output_id }),
        role: "artifact".into(),
        stored_bytes: 128,
        logical_bytes: Some(128),
        created_by: None,
        hidden: false,
        representation_of: None,
    })
    .await
    .expect("insert source column")
    .id
}

/// Insert the source `sparse_csc` expression matrix (rows × cols) owned by `dataset`.
async fn put_source_matrix(repo: &CatalogRepository, dataset: Uuid) -> Uuid {
    let k = key();
    repo.insert_artifact(&NewArtifact {
        project_id: None,
        dataset_id: Some(dataset),
        run_id: None,
        output_id: "expression".into(),
        datatype: "data/opaque".into(),
        object_key: Some(k.clone()),
        is_multifile: true,
        content_hash: k,
        structure: json!({ "encoding": "zarr_v3", "kind": "sparse_csc", "shape": [N_ROWS, N_COLS] }),
        meta: json!({ "display_name": "expression" }),
        role: "artifact".into(),
        stored_bytes: 4096,
        logical_bytes: Some(4096),
        created_by: None,
        hidden: false,
        representation_of: None,
    })
    .await
    .expect("insert source matrix")
    .id
}

/// The run-produced MARKED keep-mask (row-aligned over ALL input rows): a STORED artifact in the
/// run's scope, carrying the `filter_mask` object marker with the run label.
async fn put_produced_mask(repo: &CatalogRepository, source_dataset: Uuid, run_id: Uuid) -> Uuid {
    let k = key();
    repo.insert_artifact(&NewArtifact {
        project_id: None,
        dataset_id: Some(source_dataset),
        run_id: Some(run_id),
        output_id: format!("metadata-column:{LABEL}"),
        datatype: "data/opaque".into(),
        object_key: Some(k.clone()),
        is_multifile: true,
        content_hash: k,
        structure: json!({
            "encoding": "zarr_v3", "kind": "table", "axis": "rows", "n": N_ROWS,
            "columns": [{ "name": "values", "path": "values", "kind": "numeric",
                          "dtype": "bool", "shape": [N_ROWS], "axis": "rows", "n": N_ROWS }],
        }),
        // The producer marker: an object carrying the run LABEL (DEC-6). NO source recorded yet —
        // the sink stamps `meta.sources[]` from the expression input's dataset.
        meta: json!({ "filter_mask": { "label": LABEL } }),
        role: "artifact".into(),
        stored_bytes: N_ROWS as i64,
        logical_bytes: Some(N_ROWS as i64),
        created_by: None,
        hidden: false,
        representation_of: None,
    })
    .await
    .expect("insert produced mask")
    .id
}

/// The whole scene: a source dataset with a matrix + a row column + a col column, and a
/// running dataset-scoped job whose params bind the source matrix at `expression` and that has
/// produced a marked keep-mask. Returns `(pool, job, source_dataset, mask_id, [matrix, rows, cols])`.
async fn scene(
    server: &TestServer,
) -> (
    sqlx::PgPool,
    cytoanalyst::modules::jobs::models::Job,
    Uuid,
    Uuid,
    [Uuid; 3],
) {
    let token = setup_admin(server).await;
    let pool = pool_for(server).await;
    let owner = admin_user_id(&pool).await;
    let repo = CatalogRepository::new(pool.clone());

    let source: Uuid = create_dataset(server, &token, "source-ds")
        .await
        .parse()
        .unwrap();

    let matrix = put_source_matrix(&repo, source).await;
    let rows_col = put_source_column(
        &repo,
        source,
        "cluster",
        "rows",
        N_ROWS,
        "categorical",
        "uint8",
    )
    .await;
    let cols_col = put_source_column(
        &repo,
        source,
        "col_symbol",
        "cols",
        N_COLS,
        "string",
        "utf8",
    )
    .await;

    // A running analysis job, dataset-scoped to the source (insert_running_job writes job_scope).
    let job_id = insert_running_job(&pool, owner, "analysis", Some(source)).await;
    // Its params: a minimal AnalysisSpec binding the matrix at `expression` (the channel the sink
    // resolves the source dataset from).
    let params = json!({
        "language": "python",
        "script": "# filter (stub for the spec parser; the run is fabricated)\n",
        "inputs": [ { "slot": "expression", "artifact_ref": matrix } ],
    });
    sqlx::query("UPDATE jobs SET params = $2 WHERE id = $1")
        .bind(job_id)
        .bind(&params)
        .execute(&pool)
        .await
        .expect("set job params");

    let mask = put_produced_mask(&repo, source, job_id).await;

    let job = cytoanalyst::modules::jobs::repository::JobRepository::new(pool.clone())
        .get_any(job_id)
        .await
        .expect("fetch job")
        .expect("job row");

    (pool, job, source, mask, [matrix, rows_col, cols_col])
}

/// **A filter run creates a `source='filter'` virtual dataset (TEST-36, DEC-6, INV-1).**
///
/// nc: make `create_filter_vd_for_run` skip the mask re-bind and `mask_role` stays `artifact` /
/// the source is unknowable; skip the run-label name and the VD is named from the source.
#[tokio::test]
async fn a_filter_run_creates_a_filter_virtual_dataset() {
    let server = TestServer::spawn().await;
    let (pool, job, source, mask, [matrix, rows_col, cols_col]) = scene(&server).await;

    let outcome = create_filter_vd_for_run(&pool, &job)
        .await
        .expect("filter VD creation");
    let FilterOutcome::Created {
        dataset_id: vd,
        gathered,
        ..
    } = outcome
    else {
        panic!("expected a filter VD to be created, got {outcome:?}");
    };

    // The dataset row: source='filter', NAMED from the run label.
    let ds = sqlx::query!(
        "SELECT name, source, metadata as \"metadata: serde_json::Value\" FROM datasets WHERE id = $1",
        vd
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        ds.source, DATASET_SOURCE_FILTER,
        "the VD is a filter dataset"
    );
    assert_eq!(ds.name, LABEL, "the VD is NAMED from the run label (DEC-6)");
    assert_eq!(
        ds.metadata["filter"]["source_dataset_id"],
        json!(source.to_string()),
        "the VD records its source dataset"
    );

    // The mask: re-bound to the VD, role='mask', hidden, recording its source (§3.4).
    let m = sqlx::query!(
        "SELECT dataset_id, role, hidden, meta as \"meta: serde_json::Value\" FROM artifacts WHERE id = $1",
        mask
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(m.dataset_id, Some(vd), "the mask is owned by the VD");
    assert_eq!(m.role, MASK_ROLE, "the mask's role is 'mask'");
    assert!(
        m.hidden,
        "the mask is hidden — never a first-class artifact"
    );
    assert_eq!(
        mask_source_dataset_ids(&m.meta),
        vec![source.to_string()],
        "the mask records the source dataset it filters"
    );

    // Three gathered columns (one per source column/matrix), each a recipe row (no bytes).
    assert_eq!(
        gathered.len(),
        3,
        "one gathered column per source column/matrix"
    );
    let recipe_of = |id: Uuid| {
        let pool = pool.clone();
        async move {
            sqlx::query!(
                "SELECT dataset_id, object_key, structure as \"structure: serde_json::Value\" FROM artifacts WHERE id = $1",
                id
            )
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };
    for g in &gathered {
        let row = recipe_of(*g).await;
        assert_eq!(row.dataset_id, Some(vd), "gathered column owned by the VD");
        assert!(row.object_key.is_none(), "a gathered column owns no bytes");
        let gf = &row.structure["gathered_from"];
        assert_eq!(gf["sources"][0]["dataset_id"], json!(source.to_string()));
        assert!(
            gf["alignment_artifact_id"].is_null(),
            "a filter has no alignment"
        );
    }

    // On-axis (matrix + row column) ride the mask; the off-axis (col) column does NOT (INV-1).
    let mask_applied = |src_artifact: Uuid| {
        let pool = pool.clone();
        async move {
            let row = sqlx::query!(
                "SELECT structure as \"structure: serde_json::Value\" FROM artifacts \
                 WHERE dataset_id = $1 AND object_key IS NULL \
                   AND structure -> 'gathered_from' -> 'sources' -> 0 ->> 'artifact_id' = $2",
                vd,
                src_artifact.to_string()
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            !row.structure["gathered_from"]["mask_artifact_id"].is_null()
        }
    };
    assert!(
        mask_applied(matrix).await,
        "the expression matrix is masked (on-axis rows)"
    );
    assert!(mask_applied(rows_col).await, "the row column is masked");
    assert!(
        !mask_applied(cols_col).await,
        "the col column is OFF-axis — served identity, the mask never touches it (INV-1)"
    );

    // The SOURCE dataset is unchanged: its artifacts stay owned by it, role=artifact, with bytes.
    let source_rows = sqlx::query!(
        "SELECT count(*) as \"n!\" FROM artifacts WHERE dataset_id = $1 AND role = 'artifact' AND object_key IS NOT NULL",
        source
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(source_rows.n, 3, "the source's own columns are untouched");
}

/// **A filter VD STAMPS the creating-run + producer identity, and it reads back (EA-Stage-1
/// prerequisite; the re-audit's point #1 for the filter path).**
///
/// The integrate mirror (`creator_real_run_test`) already proves the creating run is stamped:
/// it FINDS the VD by `metadata->>'alignment_run_id' = run_id`. The filter path stamps the same
/// creator identity in three places, and NOTHING asserted any of them read back — so EA Stage 1
/// cannot yet trust "run-scoping-to-VD + a creator to attribute the VD to". This closes that:
///   1. the VD row carries `metadata.filter_run_id == run_id` (also the idempotency key the
///      per-run unique index + `existing_filter_dataset` depend on — an unstamped VD would be
///      re-minted on every boot re-finalize);
///   2. every gathered column the run PRODUCED carries `created_by == owner` (the identity that
///      `list … created_by` and any provenance attribution read);
///   3. …and `run_id == run_id`, the edge GC + provenance walk the VD back through.
///
/// nc: drop `"filter_run_id": run_id.to_string()` from `create_filter_vd_for_run`'s metadata →
///     the VD is unfindable by its creator and (1) goes red.
/// nc: set `created_by: None` on the gathered `NewArtifact` (the producer identity left null) →
///     (2) goes red.
/// nc: set `run_id: None` on the gathered `NewArtifact` → (3) goes red.
#[tokio::test]
async fn a_filter_vd_stamps_the_creating_run_and_producer_identity() {
    let server = TestServer::spawn().await;
    let (pool, job, _source, _mask, _) = scene(&server).await;
    // `create_filter_vd_for_run` resolves the run id the same way: an explicit `run_id`, else `id`.
    let run_id = job.run_id.unwrap_or(job.id);
    let owner = job.owner_id;

    let FilterOutcome::Created {
        dataset_id: vd,
        gathered,
        ..
    } = create_filter_vd_for_run(&pool, &job).await.expect("create")
    else {
        panic!("expected Created");
    };

    // (1) The VD is FINDABLE by its creating run — the same read-back shape the integrate mirror
    // uses, and the idempotency key. A cross-run id must NOT return it.
    let found: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM datasets WHERE source = $1 AND metadata ->> 'filter_run_id' = $2",
    )
    .bind(DATASET_SOURCE_FILTER)
    .bind(run_id.to_string())
    .fetch_optional(&pool)
    .await
    .expect("query the filter VD by its creating run");
    assert_eq!(
        found,
        Some(vd),
        "the filter VD must be findable by the run that created it — an unstamped filter_run_id \
         leaves the creator unattributable AND breaks the per-run idempotency guard"
    );
    let wrong: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM datasets WHERE source = $1 AND metadata ->> 'filter_run_id' = $2",
    )
    .bind(DATASET_SOURCE_FILTER)
    .bind(Uuid::new_v4().to_string())
    .fetch_optional(&pool)
    .await
    .expect("query by a foreign run id");
    assert_eq!(wrong, None, "a foreign run id must not resolve this VD");

    // (2) + (3) Every PRODUCED gathered column carries the producer identity: created_by = owner,
    // run_id = the creating run. A row with either left null is an unattributable artifact.
    assert!(
        !gathered.is_empty(),
        "the filter run produced gathered columns"
    );
    for g in &gathered {
        let row = sqlx::query!("SELECT created_by, run_id FROM artifacts WHERE id = $1", g)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            row.created_by,
            Some(owner),
            "gathered column {g} must be stamped with its producer (owner) identity"
        );
        assert_eq!(
            row.run_id,
            Some(run_id),
            "gathered column {g} must be stamped with the run that created it"
        );
    }
}

/// **A filter virtual dataset costs catalog rows, not bytes (TEST-33 / INV-33).**
///
/// nc: give a gathered column `stored_bytes > 0` and this goes red — a gathered artifact owns no
/// blob, so every one it adds contributes 0 to the deployment's stored bytes.
#[tokio::test]
async fn a_filter_virtual_dataset_costs_no_stored_bytes() {
    let server = TestServer::spawn().await;
    let (pool, job, _source, _mask, _) = scene(&server).await;

    let FilterOutcome::Created {
        dataset_id: vd,
        gathered,
        ..
    } = create_filter_vd_for_run(&pool, &job).await.expect("create")
    else {
        panic!("expected Created");
    };

    let sum = sqlx::query!(
        "SELECT COALESCE(SUM(stored_bytes), 0)::bigint as \"sum!\" FROM artifacts WHERE dataset_id = $1 AND object_key IS NULL",
        vd
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        sum.sum,
        0,
        "the {} gathered columns add 0 stored bytes",
        gathered.len()
    );
}

/// **Deleting a filter VD cascades its mask + gathered columns, NEVER the source (TEST-38).**
///
/// nc: drop the `artifacts_dataset_id_fkey ON DELETE CASCADE` and the mask/gathered rows survive a
/// deleted VD as orphans; route the cascade at the source's `dataset_id` and the source's columns
/// vanish with the VD.
#[tokio::test]
async fn deleting_a_filter_vd_cascades_its_mask_and_columns_but_not_the_source() {
    let server = TestServer::spawn().await;
    let (pool, job, source, mask, _) = scene(&server).await;

    let FilterOutcome::Created { dataset_id: vd, .. } =
        create_filter_vd_for_run(&pool, &job).await.expect("create")
    else {
        panic!("expected Created");
    };

    let count_of = |ds: Uuid| {
        let pool = pool.clone();
        async move {
            sqlx::query!(
                "SELECT count(*) as \"n!\" FROM artifacts WHERE dataset_id = $1",
                ds
            )
            .fetch_one(&pool)
            .await
            .unwrap()
            .n
        }
    };
    assert!(
        count_of(vd).await >= 4,
        "VD owns the mask + gathered columns before delete"
    );
    let source_before = count_of(source).await;

    // Delete the VD row — the FK cascade removes its owned artifacts.
    sqlx::query("DELETE FROM datasets WHERE id = $1")
        .bind(vd)
        .execute(&pool)
        .await
        .expect("delete VD");

    assert_eq!(
        count_of(vd).await,
        0,
        "the VD's mask + gathered columns are gone"
    );
    let mask_gone = sqlx::query!("SELECT id FROM artifacts WHERE id = $1", mask)
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(
        mask_gone.is_none(),
        "the mask itself is deleted with its VD"
    );
    assert_eq!(
        count_of(source).await,
        source_before,
        "the SOURCE dataset's own artifacts are untouched by the VD delete"
    );
}

/// **A compute against a filter VD receives the mask + the source artifacts, and NO merged matrix
/// (TEST-32 / INV-32).**
///
/// nc: have the resolver return a gathered (recipe) row in `sources` and this goes red — a compute
/// must receive the ALREADY-PROVIDED source matrices plus the mask index vector, never a
/// materialised merged matrix.
#[tokio::test]
async fn a_compute_against_a_filter_vd_receives_the_mask_and_no_merged_matrix() {
    let server = TestServer::spawn().await;
    let (pool, job, _source, mask, [matrix, rows_col, cols_col]) = scene(&server).await;

    let FilterOutcome::Created { dataset_id: vd, .. } =
        create_filter_vd_for_run(&pool, &job).await.expect("create")
    else {
        panic!("expected Created");
    };

    let inputs = resolve_vd_compute_inputs(&pool, vd)
        .await
        .expect("resolve compute inputs");

    // The mask is staged; a filter has no alignment.
    assert_eq!(
        inputs.mask,
        Some(mask),
        "the run receives the per-source mask"
    );
    assert!(
        inputs.alignment.is_none(),
        "a filter VD has no alignment (INV-3)"
    );

    // The sources are exactly the SOURCE dataset's own artifacts — already provided, not merged.
    let mut got = inputs.sources.clone();
    got.sort();
    let mut want = vec![matrix, rows_col, cols_col];
    want.sort();
    assert_eq!(
        got, want,
        "the sources are the source dataset's own columns/matrix"
    );

    // INV-32: no source in the staged set is a gathered (merged) row — each has real bytes.
    for s in &inputs.sources {
        let row = sqlx::query!("SELECT object_key FROM artifacts WHERE id = $1", s)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(
            row.object_key.is_some(),
            "a staged source must be a STORED artifact, never a merged/gathered matrix (INV-32)"
        );
    }
}

// ════════════════════════════════════════════════════════════════════════════════════════════
//  P1 — the mask-axis attribution is disambiguated by axis when the length is AMBIGUOUS (INV-10)
// ════════════════════════════════════════════════════════════════════════════════════════════
//
// The sink decides which source columns ride the mask by DECLARED LENGTH (== the mask's). That is
// robust when one axis has that length, but when `n_rows == n_cols` a col-axis `var` column
// has the mask's length too and would be filtered by a ROW mask — right row count, wrong axis —
// and the serve path's own length backstop cannot catch it because the lengths agree. The fix
// disambiguates by the DECLARED axis, but ONLY in that ambiguous case, so the common
// (`n_rows != n_cols`) path is byte-identical to before.

/// A `sparse_csc` matrix with an explicit `[n_rows, n_cols]` shape.
async fn put_source_matrix_shape(
    repo: &CatalogRepository,
    dataset: Uuid,
    n_rows: usize,
    n_cols: usize,
) -> Uuid {
    let k = key();
    repo.insert_artifact(&NewArtifact {
        project_id: None,
        dataset_id: Some(dataset),
        run_id: None,
        output_id: "expression".into(),
        datatype: "data/opaque".into(),
        object_key: Some(k.clone()),
        is_multifile: true,
        content_hash: k,
        structure: json!({ "encoding": "zarr_v3", "kind": "sparse_csc", "shape": [n_rows, n_cols] }),
        meta: json!({ "display_name": "expression" }),
        role: "artifact".into(),
        stored_bytes: 4096,
        logical_bytes: Some(4096),
        created_by: None,
        hidden: false,
        representation_of: None,
    })
    .await
    .expect("insert square matrix")
    .id
}

/// The run-produced marked keep-mask over `n` rows (axis `rows`).
async fn put_produced_mask_n(
    repo: &CatalogRepository,
    source_dataset: Uuid,
    run_id: Uuid,
    n: usize,
) -> Uuid {
    let k = key();
    repo.insert_artifact(&NewArtifact {
        project_id: None,
        dataset_id: Some(source_dataset),
        run_id: Some(run_id),
        output_id: format!("metadata-column:{LABEL}"),
        datatype: "data/opaque".into(),
        object_key: Some(k.clone()),
        is_multifile: true,
        content_hash: k,
        structure: json!({
            "encoding": "zarr_v3", "kind": "table", "axis": "rows", "n": n,
            "columns": [{ "name": "values", "path": "values", "kind": "numeric",
                          "dtype": "bool", "shape": [n], "axis": "rows", "n": n }],
        }),
        meta: json!({ "filter_mask": { "label": LABEL } }),
        role: "artifact".into(),
        stored_bytes: n as i64,
        logical_bytes: Some(n as i64),
        created_by: None,
        hidden: false,
        representation_of: None,
    })
    .await
    .expect("insert produced mask")
    .id
}

/// **When `n_rows == n_cols`, the row mask still rides the row columns + matrix and NOT the
/// col column — the declared axis disambiguates the coincident length (P1, INV-10).**
///
/// nc: drop the `length_ambiguous` axis-disambiguation in `create_filter_vd_for_run` (pure length
/// matching) and the col column — length 5 == the mask's 5 — is ALSO masked, filtering cols by a
/// row mask. This assertion (`!mask_applied(cols_col)`) then fails.
#[tokio::test]
async fn a_row_mask_does_not_ride_a_col_column_when_dims_coincide() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let owner = admin_user_id(&pool).await;
    let repo = CatalogRepository::new(pool.clone());

    const N: usize = 5; // n_rows == n_cols — the ambiguous coincidence

    let source: Uuid = create_dataset(&server, &token, "square-ds")
        .await
        .parse()
        .unwrap();
    let matrix = put_source_matrix_shape(&repo, source, N, N).await;
    let rows_col =
        put_source_column(&repo, source, "cluster", "rows", N, "categorical", "uint8").await;
    let cols_col =
        put_source_column(&repo, source, "col_symbol", "cols", N, "string", "utf8").await;

    let job_id = insert_running_job(&pool, owner, "analysis", Some(source)).await;
    let params = json!({
        "language": "python",
        "script": "# filter (fabricated)\n",
        "inputs": [ { "slot": "expression", "artifact_ref": matrix } ],
    });
    sqlx::query("UPDATE jobs SET params = $2 WHERE id = $1")
        .bind(job_id)
        .bind(&params)
        .execute(&pool)
        .await
        .expect("set job params");
    put_produced_mask_n(&repo, source, job_id, N).await;

    let job = cytoanalyst::modules::jobs::repository::JobRepository::new(pool.clone())
        .get_any(job_id)
        .await
        .expect("fetch job")
        .expect("job row");

    let FilterOutcome::Created { dataset_id: vd, .. } = create_filter_vd_for_run(&pool, &job)
        .await
        .expect("create filter VD")
    else {
        panic!("expected a filter VD");
    };

    let mask_applied = |src_artifact: Uuid| {
        let pool = pool.clone();
        async move {
            let row = sqlx::query!(
                "SELECT structure as \"structure: serde_json::Value\" FROM artifacts \
                 WHERE dataset_id = $1 AND object_key IS NULL \
                   AND structure -> 'gathered_from' -> 'sources' -> 0 ->> 'artifact_id' = $2",
                vd,
                src_artifact.to_string()
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            !row.structure["gathered_from"]["mask_artifact_id"].is_null()
        }
    };

    assert!(
        mask_applied(rows_col).await,
        "the ROW column shares the mask's axis and length — it rides the mask"
    );
    assert!(
        mask_applied(matrix).await,
        "the matrix (shape[0] == n_rows, no top-level axis label) rides the mask on length"
    );
    assert!(
        !mask_applied(cols_col).await,
        "the COL column has the mask's length (n_cols == n_rows) but a DIFFERENT declared axis \
         — a row mask must NOT filter cols (INV-10/INV-1); it is served identity"
    );
}

// ════════════════════════════════════════════════════════════════════════════════════════════
//  P2 — ITEM-14 / TEST-9: a 2-D artifact through a filter VD, and the two 1-D siblings that
//  replace it (the #183 settlement)
// ════════════════════════════════════════════════════════════════════════════════════════════
//
// Everything above this line is 1-D or sparse: `put_source_column` hardcodes ONE member named
// `values` with `shape: [n]`, and `put_source_matrix*` is `sparse_csc`. **Nothing anywhere in this
// repository has ever put a 2-D artifact through a filter VD**, which is exactly why the defect
// below went unnoticed (PLAN §"The #183 settlement", note 1).
//
// This section pins BOTH halves of that settlement, at opposite ends of the evidence scale:
//
// * the DEFECT, made executable — `source_gather_kind` (`virtual_dataset.rs:1516-1521`) classifies
//   "a column" purely by `structure.axis` being a non-empty string and never looks at a shape, so a
//   TWO-COMPONENT artifact (`columns: []`, one 2-D entry under `arrays`, top-level `n`)
//   is gathered AS a column; `gathered_structure` (`:574-641`) then mints
//   `columns: [{path: "values", shape: [n]}]`, `arrays: []` and a `column_selector` of the literal
//   `SOURCE_MEMBER` (`:180`). The second dimension is gone and the selector names a member the
//   source store does not have. **Fixing that is #203 and is NOT done here** — these tests exist so
//   the defect is measured and documented rather than latent, and every assertion message below is
//   a STATEMENT OF THE DEFECT, never an approval of it.
// * the REPLACEMENT, proven at the bytes — two ordinary 1-D `float32` `metadata-column` siblings
//   (`spatial_x`, `spatial_y`) plus a categorical colour column gather correctly and SERVE the kept
//   rows' real values, read back element by element from the resolved chunks.
//
// The byte-level tests build REAL zarr stores in the server's own blob dir, so they can drive the
// production resolver (`gather_exec::resolve`) over the rows `create_filter_vd_for_run` minted —
// the same source of truth `masked_serve_test` / `masked_categorical_test` use, applied here to a
// VD the FILTER SINK created rather than a hand-written recipe.

/// One 1-D zarr-v3 array in the container the gather is permitted to decode: `sharding_indexed`
/// over `bytes`+`gzip`, one shard covering the whole array, optionally carrying
/// `attributes.cyto.levels`. Lifted from `masked_serve_test::zarr_array` /
/// `masked_categorical_test::zarr_array` (which lifted it from `gather_scale_test`).
fn zarr_array(
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

/// One **2-D** zarr-v3 array — `shape: [n, width]`, with the width riding the second dimension of
/// BOTH chunk shapes. This is exactly what `cyto_zarr._array_meta` writes for a member of rank 2
/// (`shape = [n] if width is None else [n, width]`), i.e. what the shared column writer produces
/// for any `(n_entities × k)` dense member.
fn zarr_array_2d(
    prefix: &str,
    dtype: &str,
    item: usize,
    width: usize,
    elems: Vec<u8>,
) -> Vec<(String, Vec<u8>)> {
    let n = elems.len() / (item * width);
    let meta = zarr_meta(
        dtype,
        json!([n, width]),
        json!([n.max(1), width]),
    );
    zarr_member(prefix, meta, elems)
}

/// The shared `zarr.json` skeleton — the one place the codec chain is spelled, so the 1-D and 2-D
/// builders cannot drift apart on anything but the shapes.
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

/// `{prefix}/zarr.json` + the single `{prefix}/c/0` shard holding `elems`, gzipped, with the
/// sharding index (offset, length, crc placeholder) as its trailer.
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
        (
            format!("{prefix}/zarr.json"),
            serde_json::to_vec(&meta).expect("array meta"),
        ),
        (format!("{prefix}/c/0"), body),
    ]
}

/// **The `structure` a TWO-COMPONENT artifact declares** — the sibling of `put_source_column`'s
/// 1-D declaration this file never had.
///
/// Named for the SHAPE, not for any contributed datatype. That is not lint hygiene: the gather
/// is supposed to be type-BLIND — `source_gather_kind` looks only at `structure.axis` — so a
/// fixture that named a domain type would be asserting against the wrong abstraction, which is
/// part of why this shape had no coverage at all.
///
/// `columns` is EMPTY and the single member is filed under `arrays` with a 2-D `shape`, because
/// `cyto_zarr.Table._record` files a member by rank (`self._arrays if len(entry["shape"]) > 1`).
/// The member's `name`/`path` is the CALLER's — a producer of a dense 2-D member names it
/// whatever it likes and is under no obligation to call it `values`. That is the whole of the
/// mismatch below: the gather assumes the constant.
fn two_component_structure(member: &str, axis: &str, n: usize, width: usize) -> Value {
    json!({
        "encoding": "zarr_v3",
        "kind": "table",
        "axis": axis,
        "n": n,
        "columns": [],
        "arrays": [{
            "path": member, "name": member, "kind": "numeric", "dtype": "float32",
            "shape": [n, width], "axis": axis, "n": n,
        }],
    })
}

/// Insert one STORED 2-D source artifact owned by `dataset` with NO bytes behind it (a placeholder
/// `object_key`, the convention of the catalog-shape tests above), returning its id.
async fn put_source_two_component(
    repo: &CatalogRepository,
    dataset: Uuid,
    output_id: &str,
    member: &str,
    axis: &str,
    n: usize,
) -> Uuid {
    let k = key();
    repo.insert_artifact(&NewArtifact {
        project_id: None,
        dataset_id: Some(dataset),
        run_id: None,
        output_id: output_id.into(),
        datatype: "data/opaque".into(),
        object_key: Some(k.clone()),
        is_multifile: true,
        content_hash: k,
        structure: two_component_structure(member, axis, n, 2),
        meta: json!({ "display_name": output_id }),
        role: "artifact".into(),
        stored_bytes: 128,
        logical_bytes: Some(128),
        created_by: None,
        hidden: false,
        representation_of: None,
    })
    .await
    .expect("insert the 2-D source")
    .id
}

/// Insert a source artifact with REAL bytes in the server's blob store.
async fn put_stored(
    repo: &CatalogRepository,
    store: &dyn ObjectStore,
    dataset: Uuid,
    output_id: &str,
    members: Vec<(String, Vec<u8>)>,
    structure: Value,
    meta: Value,
    hidden: bool,
    run_id: Option<Uuid>,
) -> Uuid {
    let put = store.put_prefix(&members).await.expect("put_prefix");
    repo.insert_artifact(&NewArtifact {
        project_id: None,
        dataset_id: Some(dataset),
        run_id,
        output_id: output_id.into(),
        datatype: "data/opaque".into(),
        object_key: Some(put.object_key.as_str().to_string()),
        is_multifile: true,
        content_hash: put.content_hash.clone(),
        structure,
        meta,
        role: "artifact".into(),
        stored_bytes: 0,
        logical_bytes: Some(0),
        created_by: None,
        hidden,
        representation_of: None,
    })
    .await
    .expect("insert stored source")
    .id
}

/// A REAL 1-D `float32` `metadata-column` — one `values` member, `vals.len()` rows on `axis`.
/// This is the shape ITEM-4's `spatial_x` / `spatial_y` siblings are emitted in.
async fn put_stored_f32_column(
    repo: &CatalogRepository,
    store: &dyn ObjectStore,
    dataset: Uuid,
    output_id: &str,
    axis: &str,
    vals: &[f32],
) -> Uuid {
    let bytes: Vec<u8> = vals.iter().flat_map(|v| v.to_le_bytes()).collect();
    let n = vals.len();
    put_stored(
        repo,
        store,
        dataset,
        output_id,
        zarr_array("values", "float32", 4, bytes, None),
        json!({
            "encoding": "zarr_v3", "kind": "table", "axis": axis, "n": n,
            "columns": [{ "name": "values", "path": "values", "kind": "numeric",
                          "dtype": "float32", "shape": [n], "axis": axis, "n": n }],
            "arrays": [],
        }),
        json!({ "display_name": output_id }),
        false,
        None,
    )
    .await
}

/// A REAL 1-D categorical `metadata-column` — `uint8` codes plus a code-indexed `levels`
/// vocabulary on the member's `zarr.json`. Stands in for the post-filter COLOUR column.
async fn put_stored_categorical_column(
    repo: &CatalogRepository,
    store: &dyn ObjectStore,
    dataset: Uuid,
    output_id: &str,
    axis: &str,
    codes: &[u8],
    levels: Value,
) -> Uuid {
    let n = codes.len();
    put_stored(
        repo,
        store,
        dataset,
        output_id,
        zarr_array("values", "uint8", 1, codes.to_vec(), Some(levels)),
        json!({
            "encoding": "zarr_v3", "kind": "table", "axis": axis, "n": n,
            "columns": [{ "name": "values", "path": "values", "kind": "categorical",
                          "dtype": "uint8", "shape": [n], "axis": axis, "n": n }],
            "arrays": [],
        }),
        json!({ "display_name": output_id }),
        false,
        None,
    )
    .await
}

/// A REAL 2-D source artifact — one member at `shape: [n, 2]`, with its bytes actually present.
async fn put_stored_two_component(
    repo: &CatalogRepository,
    store: &dyn ObjectStore,
    dataset: Uuid,
    output_id: &str,
    member: &str,
    axis: &str,
    coords: &[[f32; 2]],
) -> Uuid {
    let bytes: Vec<u8> = coords
        .iter()
        .flat_map(|xy| xy.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>())
        .collect();
    put_stored(
        repo,
        store,
        dataset,
        output_id,
        zarr_array_2d(member, "float32", 4, 2, bytes),
        two_component_structure(member, axis, coords.len(), 2),
        json!({ "display_name": output_id }),
        false,
        None,
    )
    .await
}

/// The run-produced MARKED keep-mask with REAL `bool` bytes — the same marker
/// (`meta.filter_mask.label`) `put_produced_mask` carries, so the sink finds it, plus a store the
/// serve path can actually read.
async fn put_stored_mask(
    repo: &CatalogRepository,
    store: &dyn ObjectStore,
    dataset: Uuid,
    run_id: Uuid,
    axis: &str,
    keep: &[bool],
) -> Uuid {
    let n = keep.len();
    put_stored(
        repo,
        store,
        dataset,
        &format!("metadata-column:{LABEL}"),
        zarr_array(
            "values",
            "bool",
            1,
            keep.iter().map(|&k| k as u8).collect(),
            None,
        ),
        json!({
            "encoding": "zarr_v3", "kind": "table", "axis": axis, "n": n,
            "columns": [{ "name": "values", "path": "values", "kind": "numeric",
                          "dtype": "bool", "shape": [n], "axis": axis, "n": n }],
        }),
        json!({ "filter_mask": { "label": LABEL } }),
        false,
        Some(run_id),
    )
    .await
}

/// The common byte-level scene: an admin, a pool, the SERVER's own blob store, a source dataset
/// holding a placeholder `expression` matrix (the slot the sink reads the source dataset from — it
/// is never served here) and a RUNNING dataset-scoped job bound to it. The caller adds the source
/// columns it wants gathered plus the produced mask, then fetches the job and creates the VD.
async fn byte_scene(
    server: &TestServer,
    name: &str,
    n_rows: usize,
    n_cols: usize,
) -> (
    sqlx::PgPool,
    LocalFsStore,
    CatalogRepository,
    Uuid, // the source dataset
    Uuid, // the running job / run id
) {
    let token = setup_admin(server).await;
    let pool = pool_for(server).await;
    let owner = admin_user_id(&pool).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(server);

    let source: Uuid = create_dataset(server, &token, name).await.parse().unwrap();
    let matrix = put_source_matrix_shape(&repo, source, n_rows, n_cols).await;

    let job_id = insert_running_job(&pool, owner, "analysis", Some(source)).await;
    let params = json!({
        "language": "python",
        "script": "# filter (fabricated)\n",
        "inputs": [ { "slot": "expression", "artifact_ref": matrix } ],
    });
    sqlx::query("UPDATE jobs SET params = $2 WHERE id = $1")
        .bind(job_id)
        .bind(&params)
        .execute(&pool)
        .await
        .expect("set job params");

    (pool, store, repo, source, job_id)
}

async fn fetch_job(pool: &sqlx::PgPool, job_id: Uuid) -> cytoanalyst::modules::jobs::models::Job {
    cytoanalyst::modules::jobs::repository::JobRepository::new(pool.clone())
        .get_any(job_id)
        .await
        .expect("fetch job")
        .expect("job row")
}

/// The VD's gathered recipe row for one SOURCE artifact, or `None` if the sink minted none.
async fn gathered_for(pool: &sqlx::PgPool, vd: Uuid, src: Uuid) -> Option<Uuid> {
    sqlx::query_scalar!(
        "SELECT id FROM artifacts WHERE dataset_id = $1 AND object_key IS NULL \
           AND structure -> 'gathered_from' -> 'sources' -> 0 ->> 'artifact_id' = $2",
        vd,
        src.to_string()
    )
    .fetch_optional(pool)
    .await
    .expect("query the gathered row")
}

async fn structure_of(repo: &CatalogRepository, id: Uuid) -> Value {
    repo.get_any_status(id)
        .await
        .expect("read artifact")
        .expect("artifact row")
        .structure
}

/// Decode a resolved flat `float32` column: every chunk, concatenated, trimmed to `n × 4`.
fn decode_f32(resolved: &ResolvedGather) -> Vec<f32> {
    let mut bytes = Vec::new();
    for g in 0..resolved.chunk_count() {
        bytes.extend_from_slice(&resolved.member(&format!("values/c/{g}")).unwrap().unwrap());
    }
    bytes.truncate(resolved.n * 4);
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

/// Decode a resolved `uint8` categorical column's codes.
fn decode_u8(resolved: &ResolvedGather) -> Vec<u8> {
    let mut bytes = Vec::new();
    for g in 0..resolved.chunk_count() {
        bytes.extend_from_slice(&resolved.member(&format!("values/c/{g}")).unwrap().unwrap());
    }
    bytes.truncate(resolved.n);
    bytes
}

/// The `levels` array on the served member's `zarr.json` (`attributes.cyto.levels`).
fn served_levels(resolved: &ResolvedGather) -> Value {
    let arr: Value =
        serde_json::from_slice(&resolved.member("values/zarr.json").unwrap().unwrap()).unwrap();
    arr["attributes"]["cyto"]["levels"].clone()
}

// ── the byte-level scene's fixed row set ────────────────────────────────────────────────────
//
// Nine rows; the mask keeps rows 0, 3, 6 and 7 — every third row PLUS one more. Deliberately not
// a prefix (`0..k`) and not a contiguous run: a gather that truncated instead of filtering, or
// that dropped the mask entirely, would pass a length check and a `0..k` expectation, and must
// not pass this one.
const B_N: usize = 9;
const B_KEEP: [bool; B_N] = [
    true, false, false, true, false, false, true, true, false,
];
const B_KEPT_ROWS: [usize; 4] = [0, 3, 6, 7];

/// The kept entries of `all`, in kept (ascending source) order — the expectation every read-back
/// below is measured against.
fn kept<T: Copy>(all: &[T]) -> Vec<T> {
    all.iter()
        .zip(B_KEEP.iter())
        .filter_map(|(v, &k)| k.then_some(*v))
        .collect()
}

/// **A 2-D artifact IS gathered by the filter sink, and its SECOND DIMENSION IS DROPPED — the
/// gathered row is strictly 1-D and its `column_selector` names a member the source store does not
/// have (the defect #203 owns; ITEM-14 / TEST-9).**
///
/// This test asserts a DEFECT, not a contract. Every assertion below describes behaviour that is
/// WRONG and is expected to CHANGE when #203 teaches `gathered_structure` to carry a 2-D member;
/// whoever fixes #203 should expect to rewrite this test, not to preserve it. It exists because
/// the behaviour was previously unmeasured — no fixture in this repository had ever put a 2-D
/// artifact through a filter VD — and an unmeasured defect is indistinguishable from a design.
///
/// What the production code does, and where:
/// * `source_gather_kind` (`virtual_dataset.rs:1516-1521`) asks only whether `structure.axis` is a
///   non-empty string. It never inspects a shape, so a TWO-COMPONENT artifact (one member at
///   `shape: [n, 2]`) is classified as A COLUMN.
/// * `declared_row_count` (`:153-173`) reads the top-level `n`, so the row mask APPLIES to it.
/// * `gathered_structure` (`:574-641`) mints `columns: [{path: SOURCE_MEMBER, shape: [n]}]` and
///   `arrays: []`, and the recipe's `column_selector` is the literal `SOURCE_MEMBER` (`:180`).
#[tokio::test]
async fn a_two_dimensional_source_is_gathered_as_a_one_dimensional_column() {
    let server = TestServer::spawn().await;
    let (pool, job, source, _mask, _) = scene(&server).await;
    let repo = CatalogRepository::new(pool.clone());

    // The member a producer of a dense 2-D layout actually names — NOT `values`.
    const MEMBER: &str = "xy";
    let two_component =
        put_source_two_component(&repo, source, "layout-xy", MEMBER, "rows", N_ROWS).await;

    let FilterOutcome::Created { dataset_id: vd, .. } =
        create_filter_vd_for_run(&pool, &job).await.expect("create")
    else {
        panic!("expected a filter VD to be created");
    };

    let g = gathered_for(&pool, vd, two_component).await.expect(
        "the filter sink gathered NO row for the 2-D source. That is not the behaviour this test \
         measures: `source_gather_kind` classifies it as a column on `structure.axis` alone, so it \
         IS gathered. If this now refuses 2-D sources, the defect has been addressed and this test \
         must be rewritten against #203's contract, not deleted",
    );
    let structure = structure_of(&repo, g).await;

    // 1. The second dimension is GONE: one 1-D `columns` entry, `arrays` emptied.
    let shape = structure["columns"][0]["shape"]
        .as_array()
        .expect("the gathered row declares a column shape")
        .clone();
    assert_eq!(
        shape.len(),
        1,
        "DEFECT (#203): the gathered row for a 2-D source declares a {}-dimensional shape {:?}. \
         `gathered_structure` always mints `shape: [n]`, so the source's width (2) is DROPPED — \
         `declaredDims` reads `[n]`, `declaredComponentCount` returns undefined, and the \
         coordinates are never offered. This is the measurement, not the desired behaviour",
        shape.len(),
        structure["columns"][0]["shape"],
    );
    assert_eq!(
        shape[0],
        json!(N_ROWS),
        "DEFECT (#203): the one surviving dimension is the SOURCE row count (the serve path \
         resolves it to N_kept) — the row count is carried and the WIDTH is what was lost"
    );
    assert_eq!(
        structure["arrays"],
        json!([]),
        "DEFECT (#203): the source declared its 2-D member under `arrays`, and the gathered row \
         declares `arrays: []` — the only place a ≥2-D member can be declared is emptied"
    );

    // 2. The member selector names a member the SOURCE STORE DOES NOT HAVE.
    assert_eq!(
        structure["columns"][0]["path"],
        json!("values"),
        "DEFECT (#203): the gathered column is minted at the hardcoded member `values` \
         (SOURCE_MEMBER, virtual_dataset.rs:180) regardless of what the source named its member"
    );
    assert_eq!(
        structure["gathered_from"]["column_selector"],
        json!("values"),
        "DEFECT (#203): the recipe's `column_selector` is the literal `values`, but this source's \
         ONLY member is {MEMBER:?}. `gather_exec.rs:1128` reads that selector verbatim, so serving \
         this row asks the store for a member that is not in it"
    );
    let src_structure = structure_of(&repo, two_component).await;
    assert_eq!(
        src_structure["arrays"][0]["path"],
        json!(MEMBER),
        "the SOURCE's only member is {MEMBER:?} — the premise of the assertion above: the selector \
         and the store disagree"
    );
    assert_eq!(
        src_structure["columns"],
        json!([]),
        "the SOURCE declares NO 1-D column at all — there is no `values` member for the recipe to \
         have meant"
    );

    // 3. …and the mask was applied to it, so this is a genuinely filtered 2-D artifact, not one
    //    the sink passed through untouched.
    assert!(
        !structure["gathered_from"]["mask_artifact_id"].is_null(),
        "DEFECT (#203): the 2-D source's declared `n` equals the mask's, so `declared_row_count` \
         matches and the row mask RIDES it — the flattening above happens on the filtered path, \
         which is the path that matters"
    );
}

/// **A 2-D artifact whose member HAPPENS to be named `values` is served as a flattened 1-D column
/// of the first `n` interleaved floats — the wrong numbers, with NO error (ITEM-14 / TEST-9).**
///
/// Again: this asserts a DEFECT. The settlement's note 2 predicted this path would at least be
/// LOUD — a `GATHER_MASK_LENGTH_MISMATCH`, on the reasoning that `n_src = bytes.len() / item`
/// would be `2n` for a 2-D `float32` member. **Measured, it is not loud.** The mismatch never
/// fires, because the byte count that reaches `gather_exec.rs:1128-1140` is not the store's:
/// `DecodePlan::parse` takes `shape[0]` through `dim0` (`gather_decode.rs:164/177-183`) — a 2-D
/// `[n, 2]` shape parses as `n` elements of one `float32` each — and `decode_member` allocates
/// exactly `plan.n * item_size` bytes and copies the FRONT of each decompressed chunk into it
/// (`:298`, `:335`). So `n_src == n == mask.len()`, the guard passes, and the mask filters a
/// buffer holding `[x0, y0, x1, y1, …]` as though it were one value per row.
///
/// The consequence is worse than the settlement assumed: the served column has the right length,
/// the right dtype and a plausible `zarr.json`, and holds numbers that are not the coordinates and
/// not any column. #203 owns the fix; this test owns the fact that the failure is SILENT.
#[tokio::test]
async fn a_two_dimensional_member_named_values_serves_flattened_rows_not_coordinates() {
    let server = TestServer::spawn().await;
    let (pool, store, repo, source, run) =
        byte_scene(&server, "two-component-named-values", B_N, 4).await;

    // (x, y) pairs whose two components are far apart, so an interleaved read is unmistakable.
    let coords: Vec<[f32; 2]> = (0..B_N)
        .map(|i| [i as f32, 1000.0 + i as f32])
        .collect();
    let two_component = put_stored_two_component(
        &repo,
        &store,
        source,
        "layout-xy",
        "values", // the collision case: the store's member happens to be SOURCE_MEMBER
        "rows",
        &coords,
    )
    .await;
    put_stored_mask(&repo, &store, source, run, "rows", &B_KEEP).await;

    let job = fetch_job(&pool, run).await;
    let FilterOutcome::Created { dataset_id: vd, .. } =
        create_filter_vd_for_run(&pool, &job).await.expect("create")
    else {
        panic!("expected a filter VD to be created");
    };
    let g = gathered_for(&pool, vd, two_component)
        .await
        .expect("the 2-D source is gathered as a column");

    let resolved = resolve(&pool, &store, g, &structure_of(&repo, g).await).await;

    // What the coordinates ACTUALLY are at the kept rows — what a correct gather would serve.
    let kept_coords: Vec<[f32; 2]> = kept(&coords);
    // What the flattening produces: the member read as a 1-D `float32` array of length n, i.e.
    // the first n interleaved floats, then masked positionally.
    let flat: Vec<f32> = coords.iter().flatten().copied().take(B_N).collect();
    let expected_flat: Vec<f32> = kept(&flat);

    match resolved {
        Err(e) => panic!(
            "DEFECT (#203) — behaviour has CHANGED: serving a 2-D member named `values` now \
             refuses with {e:?}. That is LOUDER than what this test measured (a silent flattened \
             read) and may well be #203 landing. Re-derive the expectation against #203's \
             contract; do not weaken this test to accept both."
        ),
        Ok(r) => {
            assert_eq!(
                r.n,
                B_KEPT_ROWS.len(),
                "DEFECT (#203): the served column reports {} kept rows — the length is PLAUSIBLE, \
                 which is precisely why the flattening below is silent. The predicted \
                 GATHER_MASK_LENGTH_MISMATCH does NOT fire: `DecodePlan` reads shape[0] of the \
                 [n, 2] member as n elements, so n_src == mask.len()",
                B_KEPT_ROWS.len()
            );
            let got = decode_f32(&r);
            assert_eq!(
                got, expected_flat,
                "DEFECT (#203): the served values are the first {B_N} INTERLEAVED floats of the \
                 (x, y) buffer, masked positionally — {expected_flat:?}. The kept rows' actual \
                 coordinates are {kept_coords:?}, and nothing in the response says otherwise. \
                 This is the silent-wrong-data measurement the #203 fix must eliminate"
            );
            assert_ne!(
                got,
                kept_coords.iter().map(|xy| xy[0]).collect::<Vec<f32>>(),
                "DEFECT (#203): the served column is NOT the kept rows' x coordinates either — it \
                 is neither component, it is the interleaving"
            );
        }
    }
}

/// **The Option A siblings — two ordinary 1-D `float32` `metadata-column`s — gather correctly and
/// SERVE the kept rows' real values, element by element (ITEM-14 / TEST-9, INV-25).**
///
/// This is the half of the #183 settlement that must hold: P1 emits `spatial_x` / `spatial_y`
/// beside the 2-D coordinates artifact precisely because a 1-D column survives the gather intact
/// where the 2-D one does not. Nothing here is a length check or a row count — the served bytes are
/// decoded and compared to the kept rows' values, in kept order, one element at a time, with a mask
/// that keeps rows 0, 3, 6, 7 (not a prefix, not contiguous).
///
/// nc: drop the `MaskPlan::apply` filter and each column serves all nine source values. nc: index
/// the mask in reverse and the kept values arrive permuted. nc: keep `0..4` instead and the
/// expectation no longer matches the mask.
#[tokio::test]
async fn the_option_a_siblings_serve_the_kept_rows_values() {
    let server = TestServer::spawn().await;
    let (pool, store, repo, source, run) = byte_scene(&server, "option-a-siblings", B_N, 4).await;

    // Two columns whose values are unrelated to each other AND to the row index, so a column mixed
    // up with its sibling, or an off-by-one, is visible in the values themselves.
    let xs: Vec<f32> = (0..B_N).map(|i| i as f32 * 3.0 + 0.5).collect();
    let ys: Vec<f32> = (0..B_N).map(|i| 100.0 - i as f32 * 7.0).collect();
    let x_id = put_stored_f32_column(&repo, &store, source, "spatial_x", "rows", &xs).await;
    let y_id = put_stored_f32_column(&repo, &store, source, "spatial_y", "rows", &ys).await;
    put_stored_mask(&repo, &store, source, run, "rows", &B_KEEP).await;

    let job = fetch_job(&pool, run).await;
    let FilterOutcome::Created { dataset_id: vd, .. } =
        create_filter_vd_for_run(&pool, &job).await.expect("create")
    else {
        panic!("expected a filter VD to be created");
    };

    for (label, src, vals) in [("spatial_x", x_id, &xs), ("spatial_y", y_id, &ys)] {
        let g = gathered_for(&pool, vd, src)
            .await
            .unwrap_or_else(|| panic!("{label} must be gathered into the filter VD"));
        let structure = structure_of(&repo, g).await;

        // The catalog half: a 1-D `float32` column that rides the mask.
        assert_eq!(
            structure["columns"][0]["dtype"],
            json!("float32"),
            "{label}'s gathered column carries the source dtype"
        );
        assert_eq!(
            structure["columns"][0]["shape"],
            json!([B_N]),
            "{label}'s gathered column is declared at the SOURCE row count; the serve path \
             resolves it to N_kept (INV-17)"
        );
        assert!(
            !structure["gathered_from"]["mask_artifact_id"].is_null(),
            "{label} shares the mask's axis and length, so it rides the mask (INV-1)"
        );

        // The byte half: the KEPT rows' real values, in kept order, element by element.
        let resolved = resolve(&pool, &store, g, &structure)
            .await
            .unwrap_or_else(|e| panic!("{label} must resolve; got {e:?}"));
        let expected = kept(vals);
        assert_eq!(
            resolved.n,
            B_KEPT_ROWS.len(),
            "{label} serves {} rows — the mask keeps rows {B_KEPT_ROWS:?}",
            B_KEPT_ROWS.len()
        );
        let got = decode_f32(&resolved);
        assert_eq!(
            got.len(),
            expected.len(),
            "{label}: {} served value(s) against {} kept row(s)",
            got.len(),
            expected.len()
        );
        for (i, (&g_v, &e_v)) in got.iter().zip(expected.iter()).enumerate() {
            assert_eq!(
                g_v, e_v,
                "{label}: served element {i} is {g_v} but source row {} holds {e_v} — the gathered \
                 sibling must serve the KEPT rows' own values, in kept order",
                B_KEPT_ROWS[i]
            );
        }
        assert_eq!(
            got, expected,
            "{label}: the whole served column equals the kept rows' values {expected:?}"
        );
    }
}

/// **A post-filter COLOUR column — a categorical `metadata-column` on the same VD — serves the kept
/// rows' codes and the UNTOUCHED declared vocabulary (ITEM-14 / TEST-9, INV-6/13/14).**
///
/// "Coloured by a post-filter metadata-column" is the other half of the Option A premise, and it is
/// proven here on the SAME filter VD the coordinate siblings live on, from the same mask. The
/// vocabulary is deliberately non-alphabetical so `levels[code]` is not a no-op and an off-by-one
/// in the row selection changes the labels.
///
/// nc: derive the served `levels` from the surviving codes and the level whose every row the mask
/// dropped vanishes (INV-14). nc: drop the mask filter and all nine codes come back.
#[tokio::test]
async fn a_post_filter_colour_column_serves_the_kept_rows_codes_and_levels() {
    let server = TestServer::spawn().await;
    let (pool, store, repo, source, run) = byte_scene(&server, "post-filter-colour", B_N, 4).await;

    let levels = json!(["zebra", "apple", "mango"]);
    //            row: 0  1  2  3  4  5  6  7  8
    let codes: [u8; B_N] = [2, 0, 1, 0, 2, 1, 0, 1, 2];
    let xs: Vec<f32> = (0..B_N).map(|i| i as f32 * 3.0 + 0.5).collect();

    let colour = put_stored_categorical_column(
        &repo,
        &store,
        source,
        "cluster",
        "rows",
        &codes,
        levels.clone(),
    )
    .await;
    // A coordinate sibling on the same VD, so the colour column is proven on the very dataset the
    // filtered scatter would be drawn from — not on a VD of its own.
    let x_id = put_stored_f32_column(&repo, &store, source, "spatial_x", "rows", &xs).await;
    put_stored_mask(&repo, &store, source, run, "rows", &B_KEEP).await;

    let job = fetch_job(&pool, run).await;
    let FilterOutcome::Created { dataset_id: vd, .. } =
        create_filter_vd_for_run(&pool, &job).await.expect("create")
    else {
        panic!("expected a filter VD to be created");
    };

    let g = gathered_for(&pool, vd, colour)
        .await
        .expect("the colour column must be gathered into the filter VD");
    let structure = structure_of(&repo, g).await;
    assert_eq!(
        structure["columns"][0]["kind"],
        json!("categorical"),
        "the gathered colour column CARRIES the source's `categorical` kind — it is not re-decided"
    );

    let resolved = resolve(&pool, &store, g, &structure)
        .await
        .expect("resolve the gathered colour column");
    let expected_codes = kept(&codes);
    assert_eq!(
        resolved.n,
        B_KEPT_ROWS.len(),
        "the colour column serves one code per kept row"
    );
    let got = decode_u8(&resolved);
    for (i, (&g_c, &e_c)) in got.iter().zip(expected_codes.iter()).enumerate() {
        assert_eq!(
            g_c, e_c,
            "served code {i} is {g_c} but source row {} holds {e_c} — a filtered colour column \
             must carry the KEPT rows' own codes",
            B_KEPT_ROWS[i]
        );
    }
    assert_eq!(
        got, expected_codes,
        "the whole served code column equals the kept rows' codes {expected_codes:?}"
    );
    let labels: Vec<&str> = got
        .iter()
        .map(|&c| levels[c as usize].as_str().unwrap())
        .collect();
    let expected_labels: Vec<&str> = expected_codes
        .iter()
        .map(|&c| levels[c as usize].as_str().unwrap())
        .collect();
    assert_eq!(
        labels, expected_labels,
        "the labels of the kept rows, resolved through the code-indexed vocabulary"
    );
    assert_eq!(
        served_levels(&resolved),
        levels,
        "the served vocabulary is the DECLARED set, untouched by the mask (INV-14), and it rides \
         the output member's own zarr.json so one metadata fetch matches the served codes (INV-13)"
    );

    // The coordinate sibling on the same VD still serves its own kept values — the colour column
    // and the coordinate column are read through the SAME mask.
    let gx = gathered_for(&pool, vd, x_id)
        .await
        .expect("the coordinate sibling is gathered onto the same VD");
    let rx = resolve(&pool, &store, gx, &structure_of(&repo, gx).await)
        .await
        .expect("resolve the coordinate sibling");
    assert_eq!(
        decode_f32(&rx),
        kept(&xs),
        "on the SAME VD, the coordinate sibling serves the same kept rows the colour column does"
    );
}
