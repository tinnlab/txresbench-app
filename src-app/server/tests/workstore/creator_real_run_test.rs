//! **THE ACCEPTANCE TEST FOR THE CREATOR** — a REAL `embedding-integrate` run, through the
//! real runner, in the real sandbox, produces a virtual dataset whose fused categorical the
//! ORDINARY catalog route serves **with its labels**.
//!
//! ## Why this file has to exist, and why no test already here counts
//!
//! Every other gathered-artifact test in this tree inserts its rows through
//! `CatalogRepository`. A reader and a fixture written by one hand agree by construction, and
//! that is not a figure of speech here: two CRITICALs of this stage — rows served from the
//! wrong dataset, and category labels swapped across datasets — lived behind a fully green
//! suite for weeks, because nothing in the loop had ever been written by the PRODUCER.
//!
//! So the discriminating property of this test is not what it asserts. It is where the rows
//! come from: **nothing here writes an artifacts row**. The compute writes the alignment, the
//! runner ingests it, and `workstore::virtual_dataset` — the creator — writes the virtual
//! dataset and its gathered columns from what it finds. A fourth writer of test-authored rows
//! would deepen the hole rather than close it.
//!
//! ## What it is NOT
//!
//! `embedding-integrate` declares `launchable: false` (stage 3 owns the form), so this run is
//! **HARNESS-started, not UI-started**. That is a real run for the READER's purposes — which
//! is what this stage owns — but it is emphatically **not** the claim "a user can do this end
//! to end". Stage 3's form is what converts one claim into the other, and the two must not be
//! conflated anywhere this result is recorded.
//!
//! ## The sources are the committed stage-1 fixture stores, and that is the point
//!
//! `tests/fixtures/stage1_alignment/sources/*.zarr` are the REAL writer's output
//! (`txr_columns.write_metadata_column`), regenerated and compared on every run by
//! `stage1_fixture_drift_test`. Binding them means the run reads stores of the shape ingest
//! actually emits — one member, always `values`, with the column's name nowhere inside it.
//! A hand-built store here would test a shape the server never produces, which is the exact
//! defect the old `entities.zarr`/`rows.zarr` fixture was.
//!
//! **The alignment is NOT the committed one.** The producer recomputes it from these sources
//! under this run's own `params`, so every value the creator reads is minted by this run.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::common::TestServer;
use crate::dataset::hardening_common::{record_skip, rootfs_gate, run_real_analysis};

use super::{create_project, pool_for, server_store, setup_admin};

const TEST: &str = "workstore::creator_real_run";

/// The fixture whose sources this run reads. The DEFAULT (non-`--agreeing`) fixture, so the
/// declared ordering and the array ordering genuinely disagree — see the stage-1 fixture
/// table. Nothing about the creator reads a segment order, but binding the coinciding
/// fixture would leave that claim untested at the one moment a real alignment is in hand.
const FIXTURE: &str = "stage1_alignment";

fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(FIXTURE)
}

/// A source store's own `attributes.txr` — which is verbatim what ingest records as the
/// artifact's `structure`.
///
/// Read off disk rather than written here, so the catalog row this test creates carries the
/// producer's declaration and not this file's idea of one. It is also what makes
/// `derive_artifact_mount_name` produce `<slot>.zarr` (it reads `structure.encoding`).
fn store_structure(store: &Path) -> Value {
    let zarr: Value = serde_json::from_slice(
        &std::fs::read(store.join("zarr.json"))
            .unwrap_or_else(|e| panic!("{}: {e}", store.display())),
    )
    .expect("zarr.json parses");
    zarr.pointer("/attributes/txr")
        .cloned()
        .unwrap_or_else(|| panic!("{}: a real store stamps attributes.txr", store.display()))
}

/// Ingest one fixture store as a project artifact, returning `(id, content_hash)`.
///
/// Deliberately through the OBJECT STORE + `CatalogRepository`, because these are the run's
/// INPUTS — artifacts that in production arrive from an earlier import run. The thing under
/// test is what the creator writes about the run's OUTPUT, and nothing here writes any part
/// of that.
async fn stage_source(
    repo: &txresbench::modules::workstore::catalog::repository::CatalogRepository,
    store: &dyn txresbench::modules::workstore::object_store::ObjectStore,
    project: Uuid,
    output_id: &str,
    dir_name: &str,
) -> (Uuid, String) {
    use txresbench::modules::workstore::catalog::models::NewArtifact;

    let dir = fixture_root().join("sources").join(dir_name);
    let mut members: Vec<(String, Vec<u8>)> = Vec::new();
    for entry in walkdir(&dir) {
        let rel = entry
            .strip_prefix(&dir)
            .expect("member under the store")
            .to_string_lossy()
            .replace('\\', "/");
        members.push((rel, std::fs::read(&entry).expect("member bytes")));
    }
    assert!(
        !members.is_empty(),
        "{dir_name}: the fixture store has no members — the run would read an empty input and \
         the failure would surface as a producer error rather than as a missing fixture"
    );
    let put = store.put_prefix(&members).await.expect("put_prefix");
    let row = repo
        .insert_artifact(&NewArtifact {
            project_id: Some(project),
            dataset_id: None,
            run_id: Some(Uuid::new_v4()),
            output_id: output_id.to_string(),
            // The source stores' own registered type, read from the fixture's manifest
            // rather than spelled here, so this file names no contributed id.
            datatype: SOURCE_DATATYPE.to_string(),
            object_key: Some(put.object_key.as_str().to_string()),
            is_multifile: true,
            content_hash: put.content_hash.clone(),
            structure: store_structure(&dir),
            meta: json!({}),
            role: "artifact".to_string(),
            stored_bytes: 0,
            logical_bytes: Some(0),
            created_by: None,
            hidden: false,
            representation_of: None,
        })
        .await
        .expect("insert source artifact");
    (row.id, row.content_hash)
}

/// Every file under `dir`, recursively.
fn walkdir(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).unwrap_or_else(|e| panic!("{}: {e}", d.display())) {
            let p = e.expect("dir entry").path();
            if p.is_dir() {
                stack.push(p);
            } else {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}

/// The registered type the staged source artifacts carry.
///
/// It is deliberately the neutral SUPERTYPE rather than the leaf a real import emits: the
/// compute reads each store off disk and never consults the catalog row's datatype, and a raw
/// `/jobs` submission runs no `appliesTo` selector — so spelling a leaf here would put a
/// contributed id in a core test to no effect. The creator CARRIES this value onto the
/// gathered rows (it may not name one either), and nothing this test asserts depends on it,
/// which is what makes the choice free rather than convenient.
const SOURCE_DATATYPE: &str = "tabular";

fn binding(slot: &str, artifact: Uuid) -> Value {
    json!({ "slot": slot, "artifact_ref": artifact })
}

/// The virtual dataset this run created, if any.
async fn virtual_dataset_for(pool: &SqlitePool, run_id: Uuid) -> Option<(Uuid, String, Value)> {
    sqlx::query_as::<_, (Uuid, String, Value)>(
        "SELECT id, source, metadata FROM datasets
         WHERE source = 'integrate' AND metadata ->> 'alignment_run_id' = $1",
    )
    .bind(run_id.to_string())
    .fetch_optional(pool)
    .await
    .expect("query the virtual dataset")
}

#[tokio::test]
async fn a_real_integrate_run_creates_a_virtual_dataset_the_catalog_serves_with_its_labels() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;

    // ROOTFS GATE. A skip here is recorded as a SKIP, never as a pass, and `just
    // test-sandbox` converts it into a FAILURE — which is the right shape: on a host that is
    // supposed to run real compute, a missing rootfs is a broken host, not a green run.
    if rootfs_gate(&server, &token).await.is_none() {
        record_skip(
            TEST,
            "no analysis rootfs available. Stage one with `just env-rootfs` and export \
             TXR_ENV_ROOTFS_SQUASHFS at the cached path (`scripts/e2e-processors-preflight.sh` \
             checks the whole chain, ending in an in-sandbox execution canary)",
        );
        return;
    }

    let project = create_project(&server, &token, "creator real run").await;
    let pool = pool_for(&server).await;
    let repo =
        txresbench::modules::workstore::catalog::repository::CatalogRepository::new(pool.clone());
    // The test process is NOT the server process, so `workstore::get_object_store()` (a
    // process-global set at the server's boot) is uninitialized here. `server_store` is a
    // LocalFsStore rooted at the SERVER's own blob dir, so what this stages is what the
    // server's data plane — and the sandbox stager — will actually read.
    let store = server_store(&server);

    // ── the grid: two datasets × {entity columns, row axis, one fused categorical} ───────
    //
    // Slot names are the producer's own families. The dataset coordinate `<i>` indexes
    // `params.dataset_ids`, which is the ONLY thing tying a slot ordinal to a dataset
    // identity — and `params.dataset_content_hashes` is what makes that relay checked rather
    // than trusted, on BOTH sides (the compute checks it, and so does the creator).
    let mut inputs: Vec<Value> = Vec::new();
    let mut dataset_ids: Vec<String> = Vec::new();
    let mut hashes = serde_json::Map::new();
    for (i, rows_store) in ["rows.zarr", "rows_1.zarr"].iter().enumerate() {
        // A REAL dataset row per source, so the alignment's `sources[].dataset_id` — and
        // therefore the recipe's — are genuine identities rather than fixture labels.
        let ds: Value = server
            .client
            .post(server.api_url("/datasets"))
            .bearer_auth(&token)
            .json(&json!({ "name": format!("source {i}") }))
            .send()
            .await
            .expect("create dataset")
            .json()
            .await
            .expect("dataset json");
        let dataset_id = ds["id"].as_str().expect("dataset id").to_string();

        for column in ["code", "alias"] {
            let (id, _) = stage_source(
                &repo,
                &store,
                project,
                &format!("src-entity-{i}-{column}"),
                &format!("entity_{i}_{column}.zarr"),
            )
            .await;
            inputs.push(binding(&format!("entity:{i}:{column}"), id));
        }
        let (rows_id, rows_hash) =
            stage_source(&repo, &store, project, &format!("src-rows-{i}"), rows_store).await;
        inputs.push(binding("rows", rows_id));
        let (level_id, _) = stage_source(
            &repo,
            &store,
            project,
            &format!("src-level-{i}-group"),
            &format!("level_{i}_group.zarr"),
        )
        .await;
        inputs.push(binding(&format!("level:{i}:group"), level_id));

        // The relay: the hash the CATALOG computed over the row-axis artifact's own bytes.
        // Supplying anything else here is what the compute's `cross_check_relay` and the
        // creator's `cross_check_row_bindings` both exist to refuse.
        hashes.insert(dataset_id.clone(), json!(rows_hash));
        dataset_ids.push(dataset_id);
    }

    let spec = json!({
        "language": "python",
        "code_ref": "compute/embedding_integrate.py",
        "package": "embedding-integrate",
        "analysis_id": "embedding.integrate",
        "inputs": inputs,
        "params": {
            "key": "code",
            "dataset_ids": dataset_ids,
            "dataset_content_hashes": hashes,
        },
    });

    let (run_id, signature) = run_real_analysis(
        &server,
        &token,
        &pool,
        Some(project),
        None,
        "integrate (acceptance)",
        spec,
    )
    .await;

    // The run really produced an alignment — read from the catalog, not asserted of the spec.
    assert!(
        signature.iter().any(|(id, _)| id.contains("alignment")),
        "the run must have cataloged an alignment output; it cataloged {signature:?}"
    );

    // ── THE CLAIM: the CREATOR wrote a virtual dataset for this run ──────────────────────
    let (virtual_id, source, metadata) = virtual_dataset_for(&pool, run_id).await.expect(
        "a successful integration run must create a virtual dataset. Nothing in \
             this test writes one — if it is absent the creator did not run, or refused, and \
             the job logs say which",
    );
    assert_eq!(source, "integrate");
    assert_eq!(
        metadata["alignment"]["source_dataset_ids"]
            .as_array()
            .expect("recorded source ids")
            .len(),
        2,
        "the virtual dataset records the datasets it reads through — that list is what GC \
         keeps reachable"
    );

    // ── …AND IT IS REACHABLE FROM THE PROJECT THE RUN RAN IN ────────────────────────────
    //
    // The row existing is not the claim; being FINDABLE is. `list_for_project_scope` reaches a
    // dataset-scoped artifact only through `project_datasets` (its second disjunct is
    // `project_id IS NULL AND dataset_id IN (SELECT … FROM project_datasets …)`), and the
    // creator's gathered rows are all dataset-scoped. Without this junction row a successful
    // integration produced a dataset that no catalog query, and therefore no picker, could
    // ever return — visible in the database and nowhere else.
    let linked: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM project_datasets WHERE project_id = $1 AND dataset_id = $2",
    )
    .bind(project)
    .bind(virtual_id)
    .fetch_one(&pool)
    .await
    .expect("count the project link");
    assert_eq!(
        linked, 1,
        "the virtual dataset must be attached to the project the run ran in, or nothing can \
         reach its artifacts"
    );

    // ── and one GATHERED artifact per column, each carrying BOTH recipe strings ──────────
    let gathered: Vec<(Uuid, String, Value)> = sqlx::query_as(
        "SELECT id, output_id, structure FROM artifacts
         WHERE dataset_id = $1 AND object_key IS NULL ORDER BY output_id",
    )
    .bind(virtual_id)
    .fetch_all(&pool)
    .await
    .expect("gathered rows");
    assert_eq!(
        gathered.len(),
        2,
        "one gathered column per fused categorical (`group`) plus the key gather; got {:?}",
        gathered.iter().map(|(_, o, _)| o).collect::<Vec<_>>()
    );

    let fused = gathered
        .iter()
        .find(|(_, _, s)| !s["gathered_from"]["alignment_column"].is_null())
        .expect("a fused categorical column");
    assert_eq!(
        fused.2["gathered_from"]["column_selector"], "values",
        "the MEMBER PATH inside each source store"
    );
    assert_eq!(
        fused.2["gathered_from"]["alignment_column"], "group",
        "…and the ALIGNMENT's name for the column, which is a DIFFERENT string. Writing the \
         member path here makes every level lookup miss and serves each source's raw code \
         space against the unified vocabulary — right row count, clean console"
    );

    // ── THE AXIS IDENTITY, PINNED FROM BOTH SIDES ───────────────────────────────────────
    //
    // A gathered row used to declare NEITHER `structure.key_sequence_digest` NOR
    // `structure.aligned_to`, which is why `gather_exec::plan_chain` had to hoist the digest
    // check and exempt intermediates — and why it recorded a residual gap in as many words: a
    // permutation of an intermediate that preserves row count was undetectable. It is the
    // creator's silence that made that true, so it is fixed here rather than in the reader.
    //
    // Read off the ALIGNMENT rather than restated, so this cannot pass against a digest the
    // producer did not mint.
    // Selected by the SAME structural signature `detach_guard` uses — a `meta.sources[]` array
    // plus a `segments` extent — rather than by a datatype id or a scope column, so this
    // survives the alignment moving between project- and dataset-scope.
    let alignment_rows: Vec<(Uuid, Option<String>)> = sqlx::query_as(
        "SELECT id, structure ->> 'key_sequence_digest' FROM artifacts
         WHERE run_id = $1 AND json_type(meta, '$.sources') = 'array'
           AND json_type(structure, '$.extents.segments') IS NOT NULL",
    )
    .bind(run_id)
    .fetch_all(&pool)
    .await
    .expect("the alignment row");
    assert_eq!(
        alignment_rows.len(),
        1,
        "exactly one alignment per run; found {alignment_rows:?}"
    );
    let unified = alignment_rows[0].1.clone();

    if let Some(unified) = unified {
        let key_col = gathered
            .iter()
            .find(|(_, _, s)| s["gathered_from"]["alignment_column"].is_null())
            .expect("the key gather");
        assert_eq!(
            key_col.2["key_sequence_digest"],
            Value::from(unified.clone()),
            "the KEY column CARRIES the unified axis, so it declares `key_sequence_digest` — \
             the field `verify_leaf_digest` reads on an artifact that carries an axis's keys"
        );
        assert!(
            key_col.2["aligned_to"].is_null(),
            "…and not the other side as well: an artifact cannot both carry an axis and merely \
             live on one, and the reader takes whichever field it finds first"
        );
        assert_eq!(
            fused.2["aligned_to"],
            Value::from(unified),
            "a FUSED column merely lives on that axis, so it declares `aligned_to` — the SAME \
             identity asserted from the opposite side"
        );
        assert!(
            fused.2["key_sequence_digest"].is_null(),
            "a fused column does not carry the keys"
        );
    } else {
        panic!(
            "the producer minted an alignment with no `structure.key_sequence_digest`, so the \
             creator has no identity to pass on. That is a producer regression, not a reason to \
             skip this assertion — an unpinned axis is exactly the state `verify_leaf_digest` \
             refuses to read through."
        );
    }

    // The key column DECLARES it is the axis index. `resolve_axis_key_artifact` selects on
    // this field plus `structure.axis`; without it the virtual dataset's own row axis has no
    // discoverable key and the dataset cannot be an input to anything.
    let axis_flags: Vec<(String, Option<bool>)> = sqlx::query_as(
        "SELECT output_id, json_extract(meta, '$.is_axis_index') = 1 FROM artifacts
         WHERE dataset_id = $1 AND object_key IS NULL ORDER BY output_id",
    )
    .bind(virtual_id)
    .fetch_all(&pool)
    .await
    .expect("axis flags");
    assert_eq!(
        axis_flags.iter().filter(|(_, f)| *f == Some(true)).count(),
        1,
        "EXACTLY one gathered column is the axis index — the key gather. Zero leaves the axis \
         anonymous; more than one makes `resolve_axis_key_artifact` ambiguous: {axis_flags:?}"
    );
    assert!(
        axis_flags.iter().all(|(_, f)| f.is_some()),
        "every gathered column ANSWERS the question, including with `false`. Absence reads as \
         \"nobody said\", which is the state the flag exists to eliminate: {axis_flags:?}"
    );

    // ── THE ACCEPTANCE READ: the ordinary catalog route, WITH the labels ─────────────────
    //
    // **The CLIENT's own address, followed rather than assumed (DEC-26).** The row declares
    // `columns[0].path`; the client resolves that member and reads `<member>/zarr.json`,
    // where a fused categorical carries its unified vocabulary at `attributes.txr.levels`.
    // This is the whole capability's user-visible surface: without it the client has codes
    // and no way to render them.
    //
    // Reading a hardcoded `zarr.json` here is what let C2 hide: the row carried no
    // `columns[]` at all, so this test passed while `parseStructure` threw on its first line
    // for every real client. The member is therefore taken FROM the declaration.
    assert_eq!(
        fused.2["encoding"], "zarr_v3",
        "the row must declare an encoding, or `parseStructure` throws before a byte is \
         fetched: {}",
        fused.2
    );
    let member = fused.2["columns"][0]["path"]
        .as_str()
        .unwrap_or_else(|| panic!("the row must declare its member: {}", fused.2))
        .to_string();
    assert_eq!(
        fused.2["columns"][0]["kind"], "categorical",
        "…and the member kind a client dispatches on: {}",
        fused.2
    );
    let decl: Value = server
        .client
        .get(server.api_url(&format!("/artifacts/{}/data/{member}/zarr.json", fused.0)))
        .bearer_auth(&token)
        .send()
        .await
        .expect("read the gathered declaration")
        .json()
        .await
        .expect("declaration json");
    let levels = decl
        .pointer("/attributes/txr/levels")
        .and_then(|l| l.as_array())
        .unwrap_or_else(|| {
            panic!(
                "the fused column must serve its UNIFIED vocabulary — the codes are \
                 unrenderable without it. Got: {decl}"
            )
        });
    assert!(
        levels.len() >= 2,
        "the unified vocabulary fuses both sources' levels; got {levels:?}"
    );

    // …and the codes themselves, through the same route the client uses.
    let chunk = server
        .client
        .get(server.api_url(&format!("/artifacts/{}/data/{member}/c/0", fused.0)))
        .bearer_auth(&token)
        .send()
        .await
        .expect("read chunk 0");
    assert_eq!(
        chunk.status().as_u16(),
        200,
        "chunk 0 of the fused column: {:?}",
        chunk.text().await
    );
    let bytes = chunk.bytes().await.expect("chunk bytes");
    assert!(!bytes.is_empty(), "a gathered chunk is not empty");
    // EVERY code must address the unified vocabulary. A gather that served a source's raw
    // codes would still be in range whenever that source's level count happened to be large
    // enough — so this is a necessary condition, not a sufficient one, and it is the
    // sufficient one that `gathered_chain_test`'s byte-exact parity assertions carry.
    for (i, code) in bytes.iter().enumerate() {
        assert!(
            (*code as usize) < levels.len(),
            "row {i} carries code {code}, which is outside the unified vocabulary of \
             {} labels — a code no label describes is an entry the client renders as nothing",
            levels.len()
        );
    }

    eprintln!(
        "[acceptance] run {run_id} → virtual dataset {virtual_id}, {} gathered column(s), \
         unified vocabulary {levels:?}",
        gathered.len()
    );
}
