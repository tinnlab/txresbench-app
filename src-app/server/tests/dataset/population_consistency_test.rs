//! TEST — the two server-side "how much is in here" totals are over ONE population.
//!
//! `CatalogRepository::footprint` (project scope, rendered as `"N results / X GB"`) and
//! `artifact_summary_rows` (dataset scope, the picker rows + holdings hover) answer the
//! same QUESTION about two different scopes. They used to answer it with two different
//! populations: the summary filtered to `status='ready' AND NOT hidden AND role='artifact'`
//! while the footprint had no `WHERE` clause at all, so a project holding a failed upload
//! reported a count and a byte total that no other surface would agree with, and nothing
//! on screen said the two measured different sets.
//!
//! ## What these tests are actually pinning
//!
//! Not "the two numbers are equal" — the two read DIFFERENT ROWS (an artifact is scoped
//! to a project OR to a dataset), so equality on arbitrary data would be meaningless. The
//! property is stronger and is what a shared definition buys: **identical composition
//! yields identical totals.** A project and a dataset holding the same five rows — one
//! usable, plus one pending, one failed, one hidden and one intermediate — must report
//! the same count and the same bytes, because both read the `usable_artifacts` view.
//!
//! The control that makes that meaningful is [`the_excluded_rows_really_are_present`]:
//! without it, "make them equal" is satisfied by two empty scopes, or by a fixture whose
//! non-usable rows silently failed to insert. It asserts the raw table holds all five
//! rows in each scope while both totals report one, so the agreement is agreement about a
//! FILTER and not about an empty set.

use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use cytoanalyst::modules::workstore::catalog::repository::CatalogRepository;

use super::hardening_common::{create_project, pool_for};
use super::{create_dataset, setup_admin};
use crate::common::TestServer;

/// The datatype every fixture row here shares — neutral on purpose (these totals hold no
/// opinion about which types exist).
const PROBE: &str = "probe/population";

/// The one row of each composition that IS usable, and its size. Kept as constants so an
/// assertion states the expectation rather than repeating a literal that could be edited
/// on one side only.
const USABLE_BYTES: i64 = 700;
const NON_USABLE_BYTES: i64 = 11_000;
const COMPOSITION_ROWS: i64 = 4;

/// Insert one artifact row into either scope. `project_id` / `dataset_id` are passed
/// straight through, so a caller writes the scope it means (exactly one, as the writing
/// code maintains).
#[allow(clippy::too_many_arguments)]
async fn insert_row(
    pool: &PgPool,
    project_id: Option<Uuid>,
    dataset_id: Option<Uuid>,
    output_id: &str,
    // LOGICAL only — `stored_bytes` keeps its 0 default, so a total computed from
    // stored bytes reads 0 and the consistency assertion fails. See the sibling
    // fixture in `artifact_summary_test`.
    logical_bytes: i64,
    role: &str,
    status: &str,
    hidden: bool,
) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO artifacts
             (id, project_id, dataset_id, output_id, datatype, object_key, is_multifile,
              content_hash, structure, meta, role, status, logical_bytes, hidden)
         VALUES ($1, $2, $3, $4, $5, $6, false, $6, '{}'::jsonb, '{}'::jsonb, $7, $8, $9, $10)",
    )
    .bind(id)
    .bind(project_id)
    .bind(dataset_id)
    .bind(output_id)
    .bind(PROBE)
    .bind(format!("sha256:{id}"))
    .bind(role)
    .bind(status)
    .bind(logical_bytes)
    .bind(hidden)
    .execute(pool)
    .await
    .expect("insert artifact row");
    id
}

/// Write THE composition into a scope: one usable row, and one of each way a row can fail
/// to be usable. Every non-usable row is deliberately much larger than the usable one, so
/// a total that included any of them is off by an amount no rounding could explain.
async fn write_composition(pool: &PgPool, project_id: Option<Uuid>, dataset_id: Option<Uuid>) {
    let at = |slot: &str| {
        format!(
            "{slot}-{}",
            if project_id.is_some() { "proj" } else { "ds" }
        )
    };
    // The one usable row.
    insert_row(
        pool,
        project_id,
        dataset_id,
        &at("usable"),
        USABLE_BYTES,
        "artifact",
        "ready",
        false,
    )
    .await;
    // Not usable: the conformance gate has not passed it.
    insert_row(
        pool,
        project_id,
        dataset_id,
        &at("pending"),
        NON_USABLE_BYTES,
        "artifact",
        "pending",
        false,
    )
    .await;
    // Not usable: the conformance gate condemned it.
    insert_row(
        pool,
        project_id,
        dataset_id,
        &at("failed"),
        NON_USABLE_BYTES,
        "artifact",
        "failed",
        false,
    )
    .await;
    // Not usable: a deliberately out-of-listing alternate representation, and a viz-only
    // intermediate. Both are `ready` — so a filter that only checked `status` still fails.
    insert_row(
        pool,
        project_id,
        dataset_id,
        &at("hidden"),
        NON_USABLE_BYTES,
        "artifact",
        "ready",
        true,
    )
    .await;
    insert_row(
        pool,
        project_id,
        dataset_id,
        &at("interm"),
        NON_USABLE_BYTES,
        "intermediate",
        "ready",
        false,
    )
    .await;
}

/// `COMPOSITION_ROWS` counts the non-usable rows; the usable one is the `+ 1`.
const TOTAL_ROWS: i64 = COMPOSITION_ROWS + 1;

async fn summary_totals(server: &TestServer, token: &str, dataset: &str) -> (i64, i64) {
    let resp = server
        .client
        .get(server.api_url("/datasets/artifact-summaries"))
        .bearer_auth(token)
        .send()
        .await
        .expect("artifact-summaries");
    assert_eq!(resp.status().as_u16(), 200, "artifact-summaries → 200");
    let body: Value = resp.json().await.expect("summary json");
    let s = body["summaries"]
        .as_array()
        .expect("summaries array")
        .iter()
        .find(|s| s["dataset_id"] == json!(dataset))
        .expect("the dataset is covered by the summary");
    (
        s["artifact_count"].as_i64().expect("artifact_count"),
        s["total_logical_bytes"].as_i64().expect("total_logical_bytes"),
    )
}

/// How many rows the scope holds in the TABLE, whatever their state — the PRESENT
/// population, read straight from `artifacts` so it cannot be affected by the view.
async fn rows_present(pool: &PgPool, column: &str, id: Uuid) -> i64 {
    sqlx::query_scalar::<_, i64>(&format!(
        "SELECT count(*) FROM artifacts WHERE {column} = $1"
    ))
    .bind(id)
    .fetch_one(pool)
    .await
    .expect("count rows present")
}

/// **The control.** Before believing any agreement below, prove there is something to
/// disagree about: each scope really holds five rows, of which exactly one is usable.
///
/// Without this, every assertion in this file is satisfied by a fixture that inserted
/// nothing — "0 == 0" is the cheapest possible way to make two totals agree, and it is
/// exactly the failure a "just make them equal" fix would leave behind.
#[tokio::test]
async fn the_excluded_rows_really_are_present() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let project = create_project(&server, &token, "population-control").await;
    let dataset = create_dataset(&server, &token, "population-control-ds").await;
    let dataset_id = Uuid::parse_str(&dataset).unwrap();

    write_composition(&pool, Some(project), None).await;
    write_composition(&pool, None, Some(dataset_id)).await;

    assert_eq!(
        rows_present(&pool, "project_id", project).await,
        TOTAL_ROWS,
        "the project scope holds every row of the composition, usable or not"
    );
    assert_eq!(
        rows_present(&pool, "dataset_id", dataset_id).await,
        TOTAL_ROWS,
        "the dataset scope holds every row of the composition, usable or not"
    );

    // And exactly one of each five is usable — so the totals asserted elsewhere are the
    // result of a FILTER, not of an empty scope.
    let usable_in_project =
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM usable_artifacts WHERE project_id = $1")
            .bind(project)
            .fetch_one(&pool)
            .await
            .expect("count usable");
    assert_eq!(
        usable_in_project, 1,
        "exactly one of the five rows is usable — four different reasons to exclude"
    );
}

/// The project-level total is over the USABLE population, which is what its label claims.
///
/// The negative controls are inside the fixture: four rows that are each excluded for a
/// DIFFERENT reason (pending / failed / hidden / intermediate), two of them `ready`, all
/// of them far larger than the usable row. A footprint that dropped any one clause of the
/// definition lands on a distinguishable number rather than merely on a wrong one.
#[tokio::test]
async fn project_footprint_counts_only_usable_artifacts() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let project = create_project(&server, &token, "population-footprint").await;
    write_composition(&pool, Some(project), None).await;

    let (count, bytes) = CatalogRepository::new(pool.clone())
        .footprint(project)
        .await
        .expect("footprint");

    assert_eq!(
        count, 1,
        "\"N results\" counts what a user can act on — not the pending, failed, hidden \
         and intermediate rows the rest of the app refuses to show them"
    );
    assert_eq!(
        bytes, USABLE_BYTES,
        "and the byte total is over the same rows the count is over"
    );
    // Stated as its own assertion because it is the specific regression: the unfiltered
    // query returned exactly this.
    assert_ne!(
        (count, bytes),
        (
            TOTAL_ROWS,
            USABLE_BYTES + COMPOSITION_ROWS * NON_USABLE_BYTES
        ),
        "the footprint is not the raw table total"
    );
}

/// **The property a single definition buys.** Identical composition ⇒ identical totals.
///
/// The two totals read different rows by design (a project's artifacts and a dataset's),
/// so this is not a claim that they are always equal. It is the claim that they MEASURE
/// THE SAME THING: give them the same five rows each and neither can answer differently,
/// because both resolve the population through the `usable_artifacts` view.
///
/// This is the assertion that fails if someone re-hand-writes either filter and gets one
/// clause wrong — which is the drift that produced the defect, twice.
#[tokio::test]
async fn project_and_dataset_totals_measure_the_same_population() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let project = create_project(&server, &token, "population-parity").await;
    let dataset = create_dataset(&server, &token, "population-parity-ds").await;
    let dataset_id = Uuid::parse_str(&dataset).unwrap();

    write_composition(&pool, Some(project), None).await;
    write_composition(&pool, None, Some(dataset_id)).await;

    let footprint = CatalogRepository::new(pool.clone())
        .footprint(project)
        .await
        .expect("footprint");
    let summary = summary_totals(&server, &token, &dataset).await;

    assert_eq!(
        footprint, summary,
        "the same composition reports the same count and bytes on the project total and \
         on the dataset summary — they are ONE population, not two that happen to agree"
    );
    assert_eq!(
        footprint,
        (1, USABLE_BYTES),
        "and the value they agree on is the USABLE one — agreement on the wrong number \
         would satisfy the assertion above"
    );
}
