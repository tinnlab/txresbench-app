//! TEST-HS-7/8/9/10/20/21/22 — the K view's integration legs: the paged
//! newest-first list (buckets, total, paging, the limit clamp), the three
//! server-side filters (kind / status incl. the multi-value OR — GROWN at
//! reconcile — and the `q` substring over file names / method ids / saved
//! set names), the shaped row + expanded block against the engine's declared
//! PROV-EE-3/EE-10 shapes (a projection, never a parallel model — INV-6),
//! the 404/empty/missing-dir shapes, and the reuse `models_used` join.
//! Every seed is synthetic (fixture patient ids, generated file names); no
//! real dataset is read anywhere.

use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use uuid::Uuid;

use super::{owner_token, pool, seed_run, SeedMethod, SeedRun};
use crate::common::TestServer;
use cytoanalyst::modules::execution_engine::repository::TxrRepository;
use cytoanalyst::modules::execution_engine::types::{
    TxrMethodState, TxrRunMode, TxrRunReason, TxrRunStatus,
};
use cytoanalyst::modules::method_catalogue::types::ReasonCode;
use cytoanalyst::modules::model_store::repository::ModelStoreRepository;

/// The K fixture-time date (stable across the seeded runs; the engine suite's
/// chrono convention).
fn at(s: &str) -> DateTime<Utc> {
    s.parse().expect("fixture timestamp")
}

/// The one-reason seed the K board's "Stopped: marker LDH is missing…" line
/// renders — the catalogue's own code + text (CONS-HS-15: verbatim, never
/// re-authored).
fn missing_marker_reason() -> TxrRunReason {
    TxrRunReason::from_catalogue(
        ReasonCode::RequiredMarkerMissing,
        "marker LDH is missing from the measurements",
    )
}

/// Seed the seven-run fixture: a finished 2-method train run (the
/// EXAMPLE-HS-1 shape: 151 patients, 38 predicted, 5 markers, landmark 56 /
/// horizon 238, 190 s, 2 produced models + a saved set, 2 log lines), a
/// stopped run (cannot_run with the marker reason), a finished reuse run
/// (consuming the saved model of the train run's set — GAP-HS-3's
/// `model_ids`), a failed run, a running run, a finished-but-not-ready run
/// and an oldest run whose dir was deleted. Returns `(server, token, repo,
/// ids)`.
async fn seed_fixture(
) -> (TestServer, String, TxrRepository, std::collections::HashMap<&'static str, (Uuid, std::path::PathBuf)>) {
    let server = TestServer::spawn().await;
    let token = owner_token(&server).await;
    let repo = TxrRepository::new(pool(&server).await);
    let store = ModelStoreRepository::new(pool(&server).await);

    let mut ids = std::collections::HashMap::new();

    // A — the train run of EXAMPLE-HS-1 (finished, 2 methods, everything the
    // K row renders, produced-model facts on BOTH methods).
    let (a_id, a_dir) = {
        let mut spec = SeedRun::finished_train("2026-10-19-1436", at("2026-10-19T14:30:00+00:00"));
        spec.files.predict_measurements = Some("new_measurements.csv".to_string());
        seed_run(&server, &repo, spec).await
    };
    ids.insert("a", (a_id, a_dir.clone()));
    // The produced-model facts (the PROV-EE-9 completeness rule) on both
    // finished methods — the batched count the K row renders must be 2.
    for mid in ["landmark-cox-current", "cox-cutpoint-risk"] {
        super::seed_produced_method(
            &repo,
            a_id,
            mid,
            &a_dir.join("models").join(mid),
            &format!("{mid}-a"),
        )
        .await;
    }
    // The saved set behind the K "Made: 2 models (CRC cohort, day 56 and one
    // more)" (PROV-MS-11 seam) + two log lines for the detail's count.
    let set = store
        .insert_set("CRC cohort, day 56", Some(a_id), None, false, None)
        .await
        .expect("seed set");
    let consumed = store
        .insert_model(&mock_model(set.id, "cox-cutpoint-risk"))
        .await
        .expect("the consumed model");
    store
        .insert_model(&mock_model(set.id, "model 2"))
        .await
        .expect("one more model in the set");
    repo.append_logs(
        a_id,
        &[
            (
                None,
                cytoanalyst::modules::execution_engine::types::TxrLogStream::Engine,
                "classified 2 methods".to_string(),
            ),
            (
                None,
                cytoanalyst::modules::execution_engine::types::TxrLogStream::Engine,
                "run finished".to_string(),
            ),
        ],
    )
    .await
    .expect("seed logs");

    // B — the stopped run (the K "Stopped or failed" bucket; the row renders
    // the missing-marker reason verbatim).
    let (b_id, b_dir) = seed_run(
        &server,
        &repo,
        SeedRun {
            status: TxrRunStatus::Stopped,
            mode: TxrRunMode::Train,
            created_at: at("2026-10-20T09:00:00+00:00"),
            started_at: Some(at("2026-10-20T09:00:01+00:00")),
            finished_at: Some(at("2026-10-20T09:00:02+00:00")),
            elapsed_secs: Some(1),
            predictions_ready: false,
            config: super::config_pfs(),
            files: super::files_train(),
            patients: Some(12),
            predict_patients: None,
            markers: 3,
            model_ids: Vec::new(),
            estimate: None,
            methods: vec![SeedMethod {
                method_id: "relchange-threshold",
                state: TxrMethodState::CannotRun,
                reason: Some(missing_marker_reason()),
                elapsed_secs: None,
                finished_at: Some(at("2026-10-20T09:00:02+00:00")),
            }],
            cpus: Some(4),
            memory_total_bytes: None,
            seed: 1,
            dir: super::SeedDir::Create("2026-10-20-0900"),
        },
    )
    .await;
    ids.insert("b", (b_id, b_dir));

    // C — the reuse run (mode reuse; consumes the SET's model through the
    // engine-grown `model_ids` — GAP-HS-3).
    let (c_id, c_dir) = {
        let mut spec = SeedRun {
            status: TxrRunStatus::Finished,
            mode: TxrRunMode::Reuse,
            created_at: at("2026-10-20T09:00:00+00:00"),
            started_at: Some(at("2026-10-20T09:02:00+00:00")),
            finished_at: Some(at("2026-10-20T09:03:00+00:00")),
            elapsed_secs: Some(60),
            predictions_ready: true,
            config: super::config_pfs(),
            files: super::files_train(),
            patients: None,
            predict_patients: Some(22),
            markers: 5,
            model_ids: vec![consumed.id.to_string()],
            estimate: None,
            methods: vec![SeedMethod {
                method_id: "jm-mem-lq",
                state: TxrMethodState::Finished,
                reason: None,
                elapsed_secs: Some(60),
                finished_at: Some(at("2026-10-20T09:03:00+00:00")),
            }],
            cpus: Some(4),
            memory_total_bytes: None,
            seed: 1,
            dir: super::SeedDir::Create("2026-10-20-0902"),
        };
        spec.files.predict_measurements = Some("march_new.csv".to_string());
        seed_run(&server, &repo, spec).await
    };
    ids.insert("c", (c_id, c_dir));

    // D — the failed run.
    let (d_id, d_dir) = seed_run(
        &server,
        &repo,
        SeedRun {
            status: TxrRunStatus::Failed,
            mode: TxrRunMode::Train,
            created_at: at("2026-10-20T10:00:00+00:00"),
            started_at: Some(at("2026-10-20T10:00:05+00:00")),
            finished_at: Some(at("2026-10-20T10:00:06+00:00")),
            elapsed_secs: Some(1),
            predictions_ready: false,
            config: super::config_pfs(),
            files: super::files_train(),
            patients: Some(12),
            predict_patients: None,
            markers: 3,
            model_ids: Vec::new(),
            estimate: None,
            methods: vec![SeedMethod {
                method_id: "landmark-cox-current",
                state: TxrMethodState::Failed,
                reason: Some(TxrRunReason {
                    code: "ENV_VERIFY_FAILED".to_string(),
                    detail: "the layer digest does not match the pinned record".to_string(),
                }),
                elapsed_secs: Some(1),
                finished_at: Some(at("2026-10-20T10:00:06+00:00")),
            }],
            cpus: Some(4),
            memory_total_bytes: None,
            seed: 1,
            dir: super::SeedDir::Create("2026-10-20-1000"),
        },
    )
    .await;
    ids.insert("d", (d_id, d_dir));

    // E — the running run (the DEC-4 bucket, can_rerun false).
    let (e_id, e_dir) = seed_run(
        &server,
        &repo,
        SeedRun {
            status: TxrRunStatus::Running,
            mode: TxrRunMode::Train,
            created_at: at("2026-10-20T11:00:00+00:00"),
            started_at: Some(at("2026-10-20T11:00:01+00:00")),
            finished_at: None,
            elapsed_secs: None,
            predictions_ready: false,
            config: super::config_pfs(),
            files: super::files_train(),
            patients: Some(12),
            predict_patients: None,
            markers: 3,
            model_ids: Vec::new(),
            estimate: None,
            methods: vec![SeedMethod {
                method_id: "jm-mem-lq",
                state: TxrMethodState::Waiting,
                reason: None,
                elapsed_secs: None,
                finished_at: None,
            }],
            cpus: Some(4),
            memory_total_bytes: None,
            seed: 1,
            dir: super::SeedDir::Create("2026-10-20-1100"),
        },
    )
    .await;
    ids.insert("e", (e_id, e_dir));

    // F — finished but predictions not ready (can_reopen/can_download false).
    let (f_id, f_dir) = seed_run(
        &server,
        &repo,
        SeedRun {
            status: TxrRunStatus::Finished,
            mode: TxrRunMode::Train,
            created_at: at("2026-10-20T11:00:00+00:00"),
            started_at: Some(at("2026-10-20T10:50:00+00:00")),
            finished_at: Some(at("2026-10-20T10:52:00+00:00")),
            elapsed_secs: Some(120),
            predictions_ready: false,
            config: super::config_pfs(),
            files: super::files_train(),
            patients: Some(30),
            predict_patients: Some(5),
            markers: 2,
            model_ids: Vec::new(),
            estimate: None,
            methods: vec![SeedMethod {
                method_id: "cox-cutpoint-risk",
                state: TxrMethodState::Finished,
                reason: None,
                elapsed_secs: Some(120),
                finished_at: Some(at("2026-10-20T10:52:00+00:00")),
            }],
            cpus: Some(4),
            memory_total_bytes: None,
            seed: 1,
            dir: super::SeedDir::Create("2026-10-20-1050"),
        },
    )
    .await;
    ids.insert("f", (f_id, f_dir));

    // G — the OLDEST run, whose run dir is then deleted (a missing dir must
    // not break the list or the detail).
    let (g_id, g_dir) = seed_run(
        &server,
        &repo,
        SeedRun {
            status: TxrRunStatus::Finished,
            mode: TxrRunMode::Train,
            created_at: at("2026-10-16T00:00:00+00:00"),
            started_at: Some(at("2026-10-16T00:00:01+00:00")),
            finished_at: Some(at("2026-10-16T00:01:00+00:00")),
            elapsed_secs: Some(59),
            predictions_ready: true,
            config: super::config_pfs(),
            files: super::files_train(),
            patients: Some(9),
            predict_patients: Some(3),
            markers: 2,
            model_ids: Vec::new(),
            estimate: None,
            methods: vec![SeedMethod {
                method_id: "jm-mem-lq",
                state: TxrMethodState::Finished,
                reason: None,
                elapsed_secs: Some(59),
                finished_at: Some(at("2026-10-16T00:01:00+00:00")),
            }],
            cpus: Some(4),
            memory_total_bytes: None,
            seed: 1,
            dir: super::SeedDir::Create("2026-10-16-0000"),
        },
    )
    .await;
    std::fs::remove_dir_all(&g_dir).expect("delete the run dir");
    ids.insert("g", (g_id, g_dir));

    (server, token, repo, ids)
}

/// A minimal but valid model-store row (the history view reads only
/// id/set_id/name/size_bytes + the joins).
fn mock_model(set_id: Uuid, name: &str) -> cytoanalyst::modules::model_store::repository::NewModel {
    // The (tree_sha256, method_id, set_id) uniqueness of the store's schema:
    // the fixture tree is a per-model opaque byte-blob (a real tree's digest
    // — here derived deterministically from the name). The store never opens
    // the bytes; only the digest is a row fact.
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(1);
    let n = SEQ.fetch_add(1, Ordering::SeqCst);
    let mut tree_sha = String::new();
    for i in 0..32u64 {
        tree_sha.push_str(&format!("{:02x}", (n + i) & 0xff));
    }
    assert_eq!(tree_sha.len(), 64, "a sha256 hex digest");
    cytoanalyst::modules::model_store::repository::NewModel {
        set_id: Some(set_id),
        name: name.to_string(),
        method_id: "cox-cutpoint-risk".to_string(),
        method_version: "1.0".to_string(),
        group: "landmark".to_string(),
        group_label: "Landmark stats".to_string(),
        task: Some("pfs".to_string()),
        provenance: "run".to_string(),
        imported_from: None,
        pretrained_catalogue_id: None,
        pretrained_catalogue_version: None,
        licence: None,
        tree_sha256: tree_sha.clone(),
        dir: format!("/data/models/trees/{tree_sha}"),
        size_bytes: 4096,
        contract: "2.0".to_string(),
        env_base_digest: Some("sha256:base0000".to_string()),
        env_layer_digest: Some("sha256:layer000".to_string()),
        trained_on_patients: Some(151),
        trained_at: Some(at("2026-10-19T15:00:00+00:00")),
        decision_day: 56.0,
        endpoint: "pfs".to_string(),
        horizon: 238.0,
        features: json!(["M1", "M2"]),
        required_markers: None,
        marker_facts: json!({"kind": "single", "count": 2, "min_draws": 3}),
        covariates: json!({"catalogue": "optional", "used": true}),
        embeds_training_data: false,
        own_auc: Some(0.66),
        own_c: Some(0.63),
    }
}

/// The local expect of the walk rule (regular files only, no symlink follow
/// — the honest figure the detail reports; the exact layout is the engine's).
fn local_dir_bytes(dir: &std::path::Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for entry in std::fs::read_dir(&d).expect("walk").flatten() {
            let meta = entry.metadata().expect("lstat");
            if meta.is_dir() {
                stack.push(entry.path());
            } else if meta.is_file() {
                total += meta.len();
            }
        }
    }
    total
}

/// GET the history page with a bearer token.
async fn list(server: &TestServer, token: &str, params: &[(&str, &str)]) -> Value {
    let resp = server
        .client
        .get(server.api_url("/txr/history"))
        .bearer_auth(token)
        .query(params)
        .send()
        .await
        .expect("history list");
    assert_eq!(resp.status().as_u16(), 200);
    resp.json().await.expect("page json")
}

fn item_ids(page: &Value) -> Vec<Uuid> {
    page["items"]
        .as_array()
        .expect("items")
        .iter()
        .map(|i| i["id"].as_str().expect("id").parse().expect("uuid"))
        .collect()
}

fn item<'a>(page: &'a Value, id: Uuid) -> &'a Value {
    page["items"]
        .as_array()
        .expect("items")
        .iter()
        .find(|i| i["id"] == id.to_string())
        .expect("the run is in the page")
}

/// TEST-HS-7 — the list is newest-first with the DEC-4 buckets, the true
/// total, stable paging (offset past the end → `items: []`) and the limit
/// clamp; the run whose dir is gone still lists (TEST-HS-10's no-500 rule).
#[tokio::test]
async fn lists_newest_first_with_buckets_paging_and_clamp() {
    let (server, token, _repo, ids) = seed_fixture().await;
    let ab_cmp = |a: &Uuid, b: &Uuid| b.cmp(a);

    let page = list(&server, &token, &[]).await;
    assert_eq!(page["total"], 7, "the true count under no filters");
    assert_eq!(page["limit"], 20, "the default limit");
    assert_eq!(page["offset"], 0);
    let seen = item_ids(&page);
    assert_eq!(seen.len(), 7);

    // Newest first, with the same-timestamp pairs ordered by id DESC (the
    // tie-break key).
    let (e_id, _) = &ids["e"];
    let (f_id, _) = &ids["f"];
    let (b_id, _) = &ids["b"];
    let (c_id, _) = &ids["c"];
    let mut expect_head: Vec<Uuid> = vec![*e_id, *f_id];
    expect_head.sort_by(ab_cmp); // id DESC is the tie-break
    let mut expect_bc: Vec<Uuid> = vec![*b_id, *c_id];
    expect_bc.sort_by(ab_cmp);
    let expected: Vec<Uuid> = [
        expect_head[0],
        expect_head[1],
        ids["d"].0,
        expect_bc[0],
        expect_bc[1],
        ids["a"].0,
        ids["g"].0,
    ]
    .to_vec();
    assert_eq!(seen, expected, "newest-first with the id tie-break");

    // The DEC-4 buckets + the capability booleans of the fixture.
    assert_eq!(item(&page, ids["a"].0)["bucket"], "finished");
    assert_eq!(item(&page, ids["b"].0)["bucket"], "stopped");
    assert_eq!(item(&page, ids["c"].0)["bucket"], "finished");
    assert_eq!(item(&page, ids["d"].0)["bucket"], "failed");
    assert_eq!(item(&page, ids["e"].0)["bucket"], "running");
    assert_eq!(item(&page, ids["e"].0)["can_rerun"], false, "running never reruns");
    assert_eq!(item(&page, ids["f"].0)["can_reopen"], false);
    assert_eq!(item(&page, ids["f"].0)["can_download"], false);
    assert_eq!(item(&page, ids["a"].0)["can_download"], true);

    // Paging: a bounded window + the engine-truth total (offset past the end
    // is the empty page, never an error).
    let page3 = list(&server, &token, &[("limit", "3")]).await;
    assert_eq!(page3["total"], 7);
    assert_eq!(page3["items"].as_array().expect("items").len(), 3);
    assert_eq!(item_ids(&page3), expected[..3]);
    let page_off = list(&server, &token, &[("limit", "3"), ("offset", "1")]).await;
    assert_eq!(
        item_ids(&page_off),
        vec![expected[1], expected[2], expected[3]],
        "offset pages from the same order"
    );
    let past_end = list(&server, &token, &[("offset", "7")]).await;
    assert_eq!(past_end["items"].as_array().expect("items").len(), 0);
    assert_eq!(past_end["total"], 7);

    // The clamp: 200 → cap 100, 0 → floor 1 (the wire echoes the applied
    // value — INV-3's boundedness).
    let capped = list(&server, &token, &[("limit", "200")]).await;
    assert_eq!(capped["limit"], 100);
    let floored = list(&server, &token, &[("limit", "0")]).await;
    assert_eq!(floored["limit"], 1);

    // The run whose dir is gone still lists (never a 500) — the detail's
    // dir facts are honest nulls/empties, not fabricated zeros (TEST-HS-10).
    let g_item = item(&page, ids["g"].0);
    assert_eq!(g_item["dir"], ids["g"].1.display().to_string());
    assert_eq!(g_item["bucket"], "finished");
    let detail = server
        .client
        .get(server.api_url(&format!("/txr/history/{}", ids["g"].0)))
        .bearer_auth(&token)
        .send()
        .await
        .expect("detail");
    assert_eq!(detail.status().as_u16(), 200);
    let dg = detail.json::<Value>().await.expect("detail json");
    assert!(dg["dir_bytes"].is_null(), "a missing dir is null, never 0");
    assert_eq!(dg["file_sizes"].as_array().expect("sizes").len(), 0);
}

/// TEST-HS-8 + TEST-HS-20 — the filters: `kind` (learned | saved-model),
/// `status` (single + the comma-separated OR — one call, the true total, the
/// same bucket vocabulary), the combined intersect, and the case-insensitive
/// `q` over method ids / saved set names / file names (the engine-grown
/// `input_summary.file_names`).
#[tokio::test]
async fn filters_kind_status_multi_and_search() {
    let (server, token, _repo, ids) = seed_fixture().await;

    // kind=learned → every train run; the reuse run is excluded.
    let learned = list(&server, &token, &[("kind", "learned")]).await;
    assert_eq!(learned["total"], 6);
    assert!(item_ids(&learned).iter().all(|id| *id != ids["c"].0));
    let saved = list(&server, &token, &[("kind", "saved-model")]).await;
    assert_eq!(saved["total"], 1);
    assert_eq!(item_ids(&saved), vec![ids["c"].0]);

    // status=single → the right subsets.
    let stopped = list(&server, &token, &[("status", "stopped")]).await;
    assert_eq!(stopped["total"], 1);
    assert_eq!(item_ids(&stopped), vec![ids["b"].0]);
    let failed = list(&server, &token, &[("status", "failed")]).await;
    assert_eq!(failed["total"], 1);
    assert_eq!(item_ids(&failed), vec![ids["d"].0]);

    // The GROWN multi-value: "Stopped or failed" is ONE call, OR semantics,
    // the true total and the same newest-first order (TEST-HS-20).
    let union = list(&server, &token, &[("status", "stopped,failed")]).await;
    assert_eq!(union["total"], 2);
    assert_eq!(item_ids(&union), vec![ids["d"].0, ids["b"].0]);

    // Combined filters intersect.
    let both = list(
        &server,
        &token,
        &[("kind", "learned"), ("status", "stopped,failed")],
    )
    .await;
    assert_eq!(both["total"], 2, "both fixture runs are learned runs");
    let neither = list(
        &server,
        &token,
        &[("kind", "saved-model"), ("status", "failed")],
    )
    .await;
    assert_eq!(neither["total"], 0);

    // q — case-insensitive over method ids.
    let q_method = list(&server, &token, &[("q", "COX-CUTPOINT")]).await;
    assert_eq!(q_method["total"], 2, "A and F run cox-cutpoint-risk");
    let mut expect: Vec<Uuid> = vec![ids["a"].0, ids["f"].0];
    expect.sort();
    let mut got = item_ids(&q_method);
    got.sort();
    assert_eq!(got, expect);

    // q — over saved set names (the source_run_id join).
    let q_set = list(&server, &token, &[("q", "crc")]).await;
    assert_eq!(q_set["total"], 1, "the set is attached to the train run");
    assert_eq!(item_ids(&q_set), vec![ids["a"].0]);

    // q — over file names (GAP-HS-1 grown: the run's own recorded names).
    let q_file = list(&server, &token, &[("q", "MARCH_NEW")]).await;
    assert_eq!(q_file["total"], 1);
    assert_eq!(item_ids(&q_file), vec![ids["c"].0]);
    let q_file2 = list(&server, &token, &[("q", "new_measurements")]).await;
    assert_eq!(q_file2["total"], 1);
    assert_eq!(item_ids(&q_file2), vec![ids["a"].0]);

    // q with no match is an empty page, never an error (TEST-HS-10).
    let none = list(&server, &token, &[("q", "zzz-no-such-term")]).await;
    assert_eq!(none["total"], 0);
    assert_eq!(none["items"].as_array().expect("items").len(), 0);
}

/// TEST-HS-9 + TEST-HS-21 + TEST-HS-22 — the shaped row and the expanded
/// block, every field asserted against the engine's declared PROV-EE-3/EE-10
/// shapes: the list item carries the K row facts (files, learned/predicted/
/// markers, endpoint/decision-day/look-ahead, compact per-method times, the
/// first terminal reason verbatim, the made/used model names, the retention
/// flag + capability booleans) and the detail carries the settings line, the
/// rich per-method rows, the saved models with sizes, the log count, the
/// recorded input-copy sizes, the copies note and the stored estimate facts.
#[tokio::test]
async fn shaped_row_and_detail_match_the_provider_shapes() {
    let (server, token, _repo, ids) = seed_fixture().await;

    // ── the EXAMPLE-HS-1 row (the finished 2-method train run) ────────────
    let page = list(&server, &token, &[("limit", "100")]).await;
    let a = item(&page, ids["a"].0).clone();
    assert_eq!(a["mode"], "train", "the engine's own vocabulary");
    assert_eq!(a["bucket"], "finished");
    assert_eq!(a["elapsed_secs"], 190);
    assert_eq!(a["estimate_total_seconds"], 240.0);
    assert_eq!(a["method_count"], 2);
    assert_eq!(
        a["file_names"],
        json!(["patients.csv", "measurements.csv", "new_measurements.csv"]),
        "the recorded names in the run's own order"
    );
    assert_eq!(a["learned_from"], 151);
    assert_eq!(a["predicted"], 38);
    assert_eq!(a["markers"], 5);
    assert_eq!(a["endpoint"], "pfs");
    assert_eq!(a["decision_day"], 56.0);
    assert_eq!(a["look_ahead_day"], 238.0);
    assert_eq!(
        a["methods"],
        json!([
            {"id": "landmark-cox-current", "version": "2.0.0", "elapsed_secs": 120},
            {"id": "cox-cutpoint-risk", "version": "2.0.0", "elapsed_secs": 70},
        ]),
        "the compact per-method refs in the run's method order"
    );
    assert!(a["reason"].is_null(), "no terminal failure → no reason");
    assert_eq!(a["models_made"]["produced"], 2, "the PROV-EE-9 count");
    assert_eq!(a["models_made"]["saved_sets"][0]["set_name"], "CRC cohort, day 56");
    assert_eq!(a["models_made"]["saved_sets"][0]["model_count"], 2);
    assert_eq!(a["models_used"], json!([]), "a train run consumes nothing");
    assert_eq!(a["copies_kept"], true, "the INV-2 lazy default");
    assert_eq!(a["can_rerun"], true);
    assert_eq!(a["can_reopen"], true);
    assert_eq!(a["can_download"], true);
    assert!(a["dir"].as_str().expect("dir").contains("/analysis-"), "the engine's dir verbatim");
    assert_eq!(a["markers_saved"], true, "produced > 0 → the save flag");

    // ── the EXAMPLE-HS-1 detail block ─────────────────────────────────────
    let da = server
        .client
        .get(server.api_url(&format!("/txr/history/{}", ids["a"].0)))
        .bearer_auth(&token)
        .send()
        .await
        .expect("detail")
        .json::<Value>()
        .await
        .expect("detail json");
    assert_eq!(
        da["settings"],
        json!({
            "endpoint": "pfs",
            "decision_day": 56.0,
            "look_ahead_day": 238.0,
            "covariates": true,
            "seed": 1,
            "cpus": 4,
            "memory_total_bytes": 16i64 * 1024 * 1024 * 1024,
            "at_a_time": 4,
            "save_models": true,
            "mode": "train",
        }),
        "the settings line from the run's config + columns"
    );
    let methods = da["methods"].as_array().expect("methods");
    assert_eq!(methods.len(), 2, "the per-method rows verbatim");
    let m0 = &methods[0];
    assert_eq!(m0["method_id"], "landmark-cox-current");
    assert_eq!(m0["label"], "landmark-cox-current", "the catalogue id is the label");
    assert_eq!(m0["version"], "2.0.0", "the catalogue's recorded facts");
    assert_eq!(m0["group"], "dynamic-risk");
    assert_eq!(m0["state"], "finished");
    assert_eq!(m0["elapsed_secs"], 120);
    assert!(m0["reason"].is_null());
    assert_eq!(da["models_saved"].as_array().expect("saved").len(), 2);
    assert_eq!(da["models_saved"][0]["set_name"], "CRC cohort, day 56");
    assert_eq!(da["models_saved"][0]["size_bytes"], 4096);
    assert_eq!(da["log_line_count"], 2);
    assert_eq!(da["copies"], json!({"kept": true, "cleared_at": null}));
    // The recorded input-copy sizes — the sizes of the files the seed wrote
    // at the engine's layout, keyed by the recorded names.
    assert_eq!(da["file_sizes"].as_array().expect("sizes").len(), 3);
    let recorded_a = &a["file_names"];
    for (i, size) in da["file_sizes"].as_array().expect("sizes").iter().enumerate() {
        assert_eq!(size["name"], recorded_a[i]);
        let expected = std::fs::metadata(
            ids["a"].1.join("input").join(match i {
                0 => "patients.csv",
                1 => "measurements.csv",
                _ => "predict-measurements.csv",
            }),
        )
        .expect("the seeded copy exists")
        .len();
        assert_eq!(size["size_bytes"], expected);
    }
    assert_eq!(
        da["dir_bytes"],
        local_dir_bytes(&ids["a"].1),
        "the run dir's recursive size (the honest walk rule)",
    );
    assert_eq!(
        da["use_estimate"],
        json!({"total_seconds": 240.0, "estimate_quality": "estimate"}),
        "the stored create-time estimate, same facts as the engine's detail"
    );
    super::assert_shared_fields_match(&a, &da);

    // ── the stopped run's reason (verbatim, never re-authored) ────────────
    let b = item(&page, ids["b"].0).clone();
    assert_eq!(
        b["reason"],
        json!({"code": "REQUIRED_MARKER_MISSING",
               "detail": "marker LDH is missing from the measurements"}),
        "the catalogue's own code + text"
    );
    // The detail's reason is the same first-terminal rule's answer (one rule
    // for the row and the block — ITEM-2).
    let db = server
        .client
        .get(server.api_url(&format!("/txr/history/{}", ids["b"].0)))
        .bearer_auth(&token)
        .send()
        .await
        .expect("detail")
        .json::<Value>()
        .await
        .expect("detail json");
    assert_eq!(db["reason"], b["reason"]);
    assert_eq!(db["methods"][0]["state"], "cannot_run");
    assert_eq!(db["methods"][0]["reason"]["code"], "REQUIRED_MARKER_MISSING");
    assert_eq!(db["copies_kept"], true);

    // ── the reuse run's `models_used` (TEST-HS-21 + TEST-HS-22) ───────────
    let c = item(&page, ids["c"].0).clone();
    assert_eq!(c["mode"], "reuse");
    assert_eq!(c["learned_from"], serde_json::Value::Null, "no training cohort");
    assert_eq!(c["predicted"], 22);
    assert_eq!(c["models_used"].as_array().expect("used").len(), 1);
    assert_eq!(c["models_used"][0]["set_name"], "CRC cohort, day 56");
    assert_eq!(c["models_used"][0]["model_name"], "cox-cutpoint-risk");
    assert_eq!(c["models_made"]["produced"], 0, "a reuse run produces nothing");
    assert_eq!(c["models_made"]["saved_sets"], json!([]));
    assert_eq!(c["file_names"], json!(["patients.csv", "measurements.csv", "march_new.csv"]));
    // The detail's join returns the same set as the row's (PK run_id).
    let dc = server
        .client
        .get(server.api_url(&format!("/txr/history/{}", ids["c"].0)))
        .bearer_auth(&token)
        .send()
        .await
        .expect("detail")
        .json::<Value>()
        .await
        .expect("detail json");
    assert_eq!(dc["models_used"], c["models_used"], "TEST-HS-22: one join shape");
    super::assert_shared_fields_match(&c, &dc);
}

/// TEST-HS-10 — the error + empty shapes: an unknown run id is the engine's
/// own 404 `RUN_NOT_FOUND` (DEC-20 — one entity, one code) and the malformed
/// status vocabulary is the 400 `INVALID_STATUS` (DRIFT #15, request-level).
#[tokio::test]
async fn unknown_run_is_404_and_bad_status_is_400() {
    let (server, token, _repo, _ids) = seed_fixture().await;

    let missing = Uuid::new_v4();
    let resp = server
        .client
        .get(server.api_url(&format!("/txr/history/{missing}")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("detail");
    assert_eq!(resp.status().as_u16(), 404);
    let body: Value = resp.json().await.expect("error json");
    assert_eq!(super::error_code(&body), "RUN_NOT_FOUND");

    let resp = server
        .client
        .get(server.api_url("/txr/history"))
        .bearer_auth(&token)
        .query(&[("status", "bogus")])
        .send()
        .await
        .expect("list");
    assert_eq!(resp.status().as_u16(), 400);
    let body: Value = resp.json().await.expect("error json");
    assert_eq!(super::error_code(&body), "INVALID_STATUS");
}
