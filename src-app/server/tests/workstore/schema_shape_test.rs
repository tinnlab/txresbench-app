//! artifact-model **TEST-12 + TEST-21** — the `artifacts` row after ITEM-7 / ITEM-15.
//!
//! Two properties, both asserted against the REAL schema and the REAL ingest path
//! (spawned server + Postgres + a content-addressed store on disk), not against Rust
//! struct source:
//!
//! * **TEST-12 (ITEM-7)** — `shape`, `params`, `covered_axes` and `storage_layout` are
//!   ABSENT from `artifacts`, and create/read/list still work end to end. The
//!   struct-level pin lives in `workstore::catalog::models` (it holds the wire); this is
//!   the one that would catch a column resurrected by a migration without a struct field.
//! * **TEST-21 (ITEM-15)** — ingest performs NO shape inference. A producer-declared
//!   `structure` is stored verbatim and is never overwritten by a value derived from the
//!   bytes. The negative control is what makes this real: the payload is a JSON columnar
//!   table of exactly the shape the deleted `infer_shape_single` used to parse (a bare
//!   column map with a categorical and a continuous column), so a server that still
//!   inferred would produce a DIFFERENT, recognisable result rather than simply passing.

use serde_json::{json, Value};
use sqlx::SqlitePool;
use uuid::Uuid;

use cytoanalyst::modules::workstore::catalog::repository::CatalogRepository;
use cytoanalyst::modules::workstore::ingest::ingest_run_outputs;
use cytoanalyst::modules::workstore::object_store::{ContentKey, ObjectStore};

use super::{create_project, pool_for, server_store, setup_admin, write_manifest};
use crate::common::TestServer;

/// The project's artifact listing as the HTTP wire actually carries it.
async fn list_artifacts_http(server: &TestServer, token: &str, project: Uuid) -> Vec<Value> {
    let listed: Value = server
        .client
        .get(server.api_url(&format!("/projects/{project}/artifacts")))
        .bearer_auth(token)
        .send()
        .await
        .expect("list")
        .json()
        .await
        .expect("list json");
    listed.as_array().expect("array").clone()
}

/// The four columns artifact-model ITEM-7 dropped.
const DROPPED_COLUMNS: [&str; 4] = ["shape", "params", "covered_axes", "storage_layout"];

async fn artifact_columns(pool: &SqlitePool) -> Vec<String> {
    sqlx::query_scalar::<_, String>(
        "SELECT column_name::text FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'artifacts'",
    )
    .fetch_all(pool)
    .await
    .expect("read artifacts columns")
}

/// TEST-12 — the columns are gone from the SCHEMA, and the surviving declarations are
/// there in their place; artifact write + read + list still work end to end.
#[tokio::test]
async fn test12_the_four_dropped_columns_are_absent_from_the_schema() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let sid = create_project(&server, &token, "schema shape").await;
    let pool = pool_for(&server).await;

    let columns = artifact_columns(&pool).await;

    // POSITIVE CONTROL: the query really did read the `artifacts` table, and the two
    // columns that REPLACED the dropped four are present. Without this, every absence
    // assertion below would pass just as well against a typo'd table name.
    assert!(
        columns.iter().any(|c| c == "datatype"),
        "the columns query returned nothing recognisable ({columns:?}) — the absence \
         assertions below would be vacuous"
    );
    for present in ["structure", "meta"] {
        assert!(
            columns.iter().any(|c| c == present),
            "`{present}` (the producer declaration that replaced the dropped four) is \
             missing from `artifacts`: {columns:?}"
        );
    }

    for dropped in DROPPED_COLUMNS {
        assert!(
            !columns.iter().any(|c| c == dropped),
            "`artifacts.{dropped}` is back. ITEM-7 dropped it — the producer declares \
             `structure` (how to decode) and `meta` (what it means), and the server holds \
             no opinion of its own about the bytes it stores."
        );
    }

    // …and the row still round-trips through the real write + read + list path, which is
    // the half of TEST-12 that proves the cross-module projection edits left no reader
    // behind (12 hand-duplicated `query_as!` projections across two repositories).
    let store = server_store(&server);
    let ws = server
        .data_dir()
        .join(format!("staging-{}", Uuid::new_v4()));
    let manifest = json!({ "outputs": [
        { "id": "report", "datatype": "report/html", "path": "r.html", "layout": "opaque",
          "role": "artifact",
          "structure": { "encoding": "opaque", "media_type": "text/html" },
          "meta": { "title": "A report" } }
    ]});
    write_manifest(&ws, &manifest, &[("r.html", b"<html>hi</html>")]).await;

    let run_id = Uuid::new_v4();
    let rows = ingest_run_outputs(&pool, &store, Some(sid), None, run_id, None, &ws)
        .await
        .expect("ingest succeeds with the four columns gone");
    assert_eq!(rows.len(), 1);

    let repo = CatalogRepository::new(pool.clone());
    let fetched = repo
        .get_any_status(rows[0].id)
        .await
        .expect("get by id")
        .expect("the row reads back");
    assert_eq!(fetched.status, "ready");
    assert_eq!(fetched.structure["media_type"], "text/html");
    assert_eq!(fetched.meta["title"], "A report");
    assert_eq!(
        repo.list_by_run(sid, run_id).await.expect("list").len(),
        1,
        "list-by-run still projects the row"
    );

    // The HTTP listing carries none of the four either (the wire, not just the struct).
    let listed = list_artifacts_http(&server, &token, sid).await;
    let row = listed
        .iter()
        .find(|a| a["output_id"] == "report")
        .expect("the ingested row is listed");
    for dropped in DROPPED_COLUMNS {
        assert!(
            row.get(dropped).is_none(),
            "`{dropped}` came back on the catalog wire"
        );
    }
}

/// TEST-21 — ingest infers NOTHING from the bytes. The declared `structure` is stored
/// verbatim, byte-for-byte as the manifest wrote it.
///
/// The payload is deliberately a shape the DELETED `infer_shape_single` knew how to
/// parse: the bare `{col:[…]}` column map (one of the three forms it accepted, and the
/// one that needs no envelope key), whose `label` column is strings and whose `score`
/// column is numbers. That function would have written
/// `{rows: 3, columns: [{name:"label",kind:"categorical"}, {name:"score",kind:"continuous"}]}`
/// — so a server that still inferred cannot pass this by accident.
///
/// The column NAMES are deliberately domain-free (INV-5). They were a domain envelope
/// key + two domain column names, which read as though the retired inference were keyed
/// to one contributed vocabulary; it was not — it dispatched on JSON SHAPE alone, and
/// the bare-map form it also accepted is what this payload uses.
#[tokio::test]
async fn test21_ingest_stores_the_declared_structure_and_infers_nothing() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let sid = create_project(&server, &token, "no inference").await;
    let pool = pool_for(&server).await;
    let store = server_store(&server);

    // The bytes the retired inference recognised…
    let inferable: Value = json!({
        "columns": ["label", "score"],
        "label": ["a", "b", "a"],
        "score": [1.0, 2.0, 3.0]
    });
    // …and a declaration that DISAGREES with what inference would have produced. If any
    // inference survived and won, this is the assertion that fails.
    let declared = json!({
        "encoding": "zarr_v3",
        "kind": "table",
        "axis": "rows",
        "n": 3,
        "columns": [{ "name": "declared_only", "dtype": "utf8" }]
    });

    let ws = server
        .data_dir()
        .join(format!("staging-{}", Uuid::new_v4()));
    let manifest = json!({ "outputs": [
        { "id": "table", "datatype": "report/html", "path": "table.json", "layout": "opaque",
          "role": "artifact", "structure": declared.clone(), "meta": { "who": "the producer" } }
    ]});
    write_manifest(
        &ws,
        &manifest,
        &[(
            "table.json",
            serde_json::to_vec(&inferable).unwrap().as_slice(),
        )],
    )
    .await;

    let run_id = Uuid::new_v4();
    let rows = ingest_run_outputs(&pool, &store, Some(sid), None, run_id, None, &ws)
        .await
        .expect("ingest succeeds");
    assert_eq!(rows.len(), 1);
    let row = &rows[0];

    assert_eq!(
        row.structure, declared,
        "the producer's `structure` is stored VERBATIM — the server neither merged into \
         it nor overwrote it with something read out of the payload (INV-1)"
    );
    assert_eq!(
        row.meta,
        json!({ "who": "the producer" }),
        "the producer's `meta` is stored verbatim too"
    );

    // The specific residue of the deleted inference: a `kind` classification per column.
    // `structure.columns` here declares a `dtype`, never a `kind`, so its presence would
    // mean the server had classified the values.
    let cols = row.structure["columns"]
        .as_array()
        .expect("the DECLARED columns survived");
    assert_eq!(cols.len(), 1, "one declared column, not two inferred ones");
    assert_eq!(cols[0]["name"], "declared_only");
    assert!(
        cols[0].get("kind").is_none(),
        "a `kind` (continuous/categorical) appeared on a column the producer described \
         with a `dtype` — that classification only ever came from reading the values"
    );

    // NEGATIVE CONTROL on the payload itself: the bytes really were parseable as the
    // shape the retired inference keyed on, so "no inference happened" is a statement
    // about the server, not about an input it could never have read anyway.
    let parsed: Value = serde_json::from_slice(
        &store
            .get(&ContentKey::parse(
            row.object_key
                .as_deref()
                .expect("this fixture artifact stores real bytes"),
        ))
            .await
            .expect("stored bytes"),
    )
    .expect("the stored payload IS the JSON columnar shape the old inference parsed");
    assert_eq!(parsed["label"][0], "a");
    assert_eq!(parsed["score"][2], 3.0);
}
