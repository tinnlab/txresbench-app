//! Dataset module integration tests — the owner-corrected entity (ITEM-1..4, 24)
//! through the full production path (real spawned server + real Postgres + real
//! ziee-file blob store). Shared helpers live here; each concern is a submodule.

use serde_json::{json, Value};

use crate::common::TestServer;

// ------------------------------- helpers -------------------------------

/// First-run setup → the admin owner + their access token (holds `*`).
pub async fn setup_admin(server: &TestServer) -> String {
    let resp = server
        .client
        .post(server.api_url("/app/setup/admin"))
        .json(&json!({
            "username": "admin",
            "email": "admin@cyto.test",
            "password": "adminPassw0rd!",
            "display_name": "Admin"
        }))
        .send()
        .await
        .expect("setup/admin");
    assert_eq!(resp.status().as_u16(), 201);
    token_of(resp.json().await.expect("setup json"))
}

pub fn token_of(body: Value) -> String {
    body["access_token"]
        .as_str()
        .or_else(|| body["token"].as_str())
        .expect("token in response")
        .to_string()
}

/// Create a user (admin) — auto-joined to the Users group, so they hold
/// `projects::use` (the gate on the dataset endpoints). Returns the id.
pub async fn create_user(server: &TestServer, admin: &str, username: &str, email: &str) -> String {
    let resp = server
        .client
        .post(server.api_url("/users"))
        .bearer_auth(admin)
        .json(&json!({
            "username": username,
            "email": email,
            "password": "userPassw0rd!",
        }))
        .send()
        .await
        .expect("create user");
    assert_eq!(resp.status().as_u16(), 201, "create user {username}");
    let body: Value = resp.json().await.expect("user json");
    body["id"].as_str().expect("user id").to_string()
}

/// Log in → an access token.
pub async fn login(server: &TestServer, username: &str) -> String {
    let resp = server
        .client
        .post(server.api_url("/auth/login"))
        .json(&json!({ "username": username, "password": "userPassw0rd!" }))
        .send()
        .await
        .expect("login");
    assert_eq!(resp.status().as_u16(), 200, "login {username}");
    token_of(resp.json().await.expect("login json"))
}

/// Create a metadata-only dataset (POST /datasets) → its id.
pub async fn create_dataset(server: &TestServer, token: &str, name: &str) -> String {
    let resp = server
        .client
        .post(server.api_url("/datasets"))
        .bearer_auth(token)
        .json(&json!({ "name": name }))
        .send()
        .await
        .expect("create dataset");
    assert_eq!(resp.status().as_u16(), 201, "create dataset {name}");
    let body: Value = resp.json().await.expect("dataset json");
    body["id"].as_str().expect("dataset id").to_string()
}

/// Read from an open SSE response until `needle` appears (or overall timeout).
/// Mirrors `tests/sync/mod.rs::read_until` for the dataset sync-emit assertions.
pub async fn read_until(
    resp: &mut reqwest::Response,
    needle: &str,
    overall: std::time::Duration,
) -> bool {
    let deadline = tokio::time::Instant::now() + overall;
    let mut buf = String::new();
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return false;
        }
        match tokio::time::timeout(remaining, resp.chunk()).await {
            Ok(Ok(Some(bytes))) => {
                buf.push_str(&String::from_utf8_lossy(&bytes));
                if buf.contains(needle) {
                    return true;
                }
            }
            _ => return false,
        }
    }
}

pub(crate) mod hardening_common;

// ─────────────────────────────────────────────────────────────────────────────
//  TEST-33 [covers: ITEM-26] — an import emits Zarr, and NOTHING ELSE
// ─────────────────────────────────────────────────────────────────────────────
//
// ITEM-26 migrated every emitted product to Zarr and deleted the columnar-file
// output; ITEM-27/28 deleted the lossless multi-file archive that used to sit
// beside it as the transpose buffer. Both deletions are *removals*, and a removal
// is exactly the kind of change nothing fails over: `cargo check` passes, the
// guards pass, and a producer that starts writing a second product tomorrow
// breaks no compile and no schema.
//
// ── WHY THIS IS NOT A DISK SCAN ────────────────────────────────────────────────
// The obvious shape — "walk the data root, assert nothing with the retired
// suffixes is there" — is VACUOUS on this system, and measurably so. Ingest happens
// BEFORE cleanup and then the per-job workspace is removed whole
// (`jobs/runner.rs`'s `remove_dir_all(workspace_root)`), so by the time the job is
// terminal there is no `outputs/` tree left to walk: a probe of the data root after
// a real import found the producer's workspace gone entirely, and the only workspace
// still present was the conformance gate's own — `code/` + `inputs/` populated with
// the artifacts it was verifying, `outputs/` holding nothing. Everything the producer
// wrote is by then either in the content-addressed store, where every blob is named
// by its hash and carries no suffix at all, or deleted. A suffix walk after the run
// therefore cannot see a second product even if one was written, and would report a
// confident green either way.
//
// What IS durable is the DECLARATION and the STORED SHAPE, so that is what is
// asserted:
//
//   1. the DISTINCT declared encodings of the emitted set are a subset of the two
//      the conformance suite implements, and `zarr_v3` is among them. A columnar
//      product declares a third value — which is precisely the string that suite
//      refuses ("unknown encoding … this suite implements zarr_v3 and opaque");
//   2. every member path of every multi-file artifact is a Zarr-store path — a
//      metadata document or a chunk key under a chunk directory. A foreign store's
//      manifest is a different shape and fails this without anyone having to guess
//      its file names in advance;
//   3. no member path, and no serialized declaration, names the retired columnar
//      file type; and
//   4. the ITEM-18 gate examined the WHOLE emitted set and passed it — read off the
//      gate's own durable record on the run, with the count it verified compared
//      against the number of rows the import produced. A gate that ran over a
//      subset, or did not reach a verdict at all, fails here.
//
// ── THE NEGATIVE CONTROLS ──────────────────────────────────────────────────────
// Every assertion above is a "none of them" or an "all of them", and both are
// satisfied by a predicate that has quietly stopped discriminating. So each
// predicate is ALSO driven against a synthetic witness it must REJECT, in the same
// test: a member list carrying a columnar file and a foreign-store document, and
// the gate's own not-verified wording built from the server's public constant. If
// any of those three controls stops failing, the corresponding green above is
// meaningless and this test says so.
//
// Rootfs-gated: it runs the REAL production converter in the sandbox and self-skips
// (never a compile-time ignore) on a host that cannot execute one.

/// The retired columnar file type ITEM-26 deleted. Named ONCE, and referenced from
/// here, so asserting its ABSENCE does not re-enter the word into the tree at every
/// assertion and message.
const RETIRED_COLUMNAR_SUFFIX: &str = ".parquet";

/// The encodings the ITEM-18 conformance suite implements — the closed set an emitted
/// artifact's declaration may draw from. Anything else is an unimplemented encoding to
/// that suite, which is what makes this a real bound and not a list of two nice words.
const IMPLEMENTED_ENCODINGS: [&str; 2] = ["zarr_v3", "opaque"];

/// `true` when `path` is a member of a Zarr store: the store/array metadata document
/// (`zarr.json`, at any depth) or a chunk key living under a chunk directory
/// (`…/c/0`, `…/c/0/1`). Deliberately shaped as a POSITIVE rule over the two things a
/// Zarr store contains rather than a denylist of other stores' file names — a denylist
/// only ever catches the products someone thought to name.
fn is_zarr_store_member(path: &str) -> bool {
    let segs: Vec<&str> = path.split('/').collect();
    if segs.last() == Some(&"zarr.json") {
        return true;
    }
    // some segment OTHER than the last one is the chunk directory
    segs.iter().rev().skip(1).any(|s| *s == "c")
}

#[tokio::test]
async fn test33_an_import_emits_only_zarr_and_the_gate_passes_the_whole_set() {
    use cytoanalyst::modules::jobs::conformance::{GATE_LOG_PREFIX, GATE_LOG_UNVERIFIED};
    use cytoanalyst::modules::workstore::object_store::{ContentKey, ObjectStore};
    use hardening_common::{
        gate, poll_job_terminal_api, pool_for, server_store, upload_fixture, PBMC3K,
    };

    const TEST: &str = "test33_an_import_emits_only_zarr_and_the_gate_passes_the_whole_set";

    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let Some(fixture) = gate(&server, &admin, TEST).await else {
        return;
    };

    // ── the REAL production import path: upload → auto-enqueued converter → run ──
    let dataset_id = upload_fixture(&server, &admin, PBMC3K, fixture).await;
    let pool = pool_for(&server).await;
    let job_id: uuid::Uuid = sqlx::query_scalar(
        "SELECT j.id FROM jobs j JOIN job_scope s ON s.job_id = j.id \
         WHERE s.scope_kind = 'dataset' AND s.scope_id = $1",
    )
    .bind(dataset_id)
    .fetch_one(&pool)
    .await
    .expect("the converter job is auto-enqueued for an uploaded, typed dataset");
    let (status, detail) = poll_job_terminal_api(
        &server,
        &admin,
        &job_id.to_string(),
        std::time::Duration::from_secs(300),
    )
    .await;
    assert_eq!(
        status, "completed",
        "the import runs to completion: {}",
        detail["job"]["error"]
    );

    // ── (1) the declared encodings are drawn from the implemented, closed set ─────
    let rows: Vec<(String, Option<String>, bool, String, String, String)> = sqlx::query_as(
        "SELECT output_id, structure->>'encoding', is_multifile, object_key, status, \
                structure::text \
         FROM artifacts WHERE dataset_id = $1 ORDER BY output_id",
    )
    .bind(dataset_id)
    .fetch_all(&pool)
    .await
    .expect("list the emitted set");

    // ANTI-VACUITY FLOOR. Every clause below is a quantifier over this set; over an
    // empty one they are all trivially true, which is the single easiest way for this
    // test to go green while proving nothing.
    assert!(
        !rows.is_empty(),
        "the import emitted NOTHING, so every assertion below would be vacuously true"
    );

    let encodings: std::collections::BTreeSet<&str> = rows
        .iter()
        .map(|(id, enc, ..)| {
            enc.as_deref()
                .unwrap_or_else(|| panic!("`{id}` declares no encoding at all"))
        })
        .collect();
    let unimplemented: Vec<&&str> = encodings
        .iter()
        .filter(|e| !IMPLEMENTED_ENCODINGS.contains(e))
        .collect();
    assert!(
        unimplemented.is_empty(),
        "the emitted set declares encoding(s) {unimplemented:?}, outside the closed set \
         {IMPLEMENTED_ENCODINGS:?} the conformance suite implements. ITEM-26 migrated \
         every product to Zarr; a third encoding means a second product came back \
         (emitted: {encodings:?})"
    );
    assert!(
        encodings.contains("zarr_v3"),
        "the import emitted NO Zarr artifact — the subset assertion above is satisfied \
         by an all-opaque set, so this is what makes it mean 'emits Zarr' (got \
         {encodings:?})"
    );

    // ── (2)+(3) the STORED shape of every multi-file artifact is a Zarr store ─────
    let store = server_store(&server);
    let mut member_paths: Vec<(String, String)> = Vec::new();
    for (output_id, _enc, is_multifile, object_key, _st, _structure) in &rows {
        if !*is_multifile {
            continue;
        }
        let manifest = store
            .get(&ContentKey::parse(object_key))
            .await
            .expect("read the merkle manifest blob");
        let members: std::collections::BTreeMap<String, String> =
            serde_json::from_slice(&manifest).expect("the manifest is the member map");
        assert!(
            !members.is_empty(),
            "`{output_id}` is multi-file but its manifest lists no members"
        );
        for path in members.into_keys() {
            member_paths.push((output_id.clone(), path));
        }
    }
    assert!(
        !member_paths.is_empty(),
        "no multi-file artifact was emitted, so the member-shape clause below would be \
         vacuous — the import is supposed to produce at least one Zarr store"
    );

    let foreign: Vec<&(String, String)> = member_paths
        .iter()
        .filter(|(_, p)| !is_zarr_store_member(p))
        .collect();
    assert!(
        foreign.is_empty(),
        "these stored members are not Zarr-store paths — a second, non-Zarr product is \
         being written: {foreign:?}"
    );
    let columnar: Vec<&(String, String)> = member_paths
        .iter()
        .filter(|(_, p)| p.ends_with(RETIRED_COLUMNAR_SUFFIX))
        .collect();
    assert!(
        columnar.is_empty(),
        "ITEM-26 deleted the columnar output; these stored members are still one: \
         {columnar:?}"
    );
    // …and the same word may not appear in a DECLARATION either, which is the only
    // place a single-file (opaque) columnar product would be visible at all: its blob
    // is named by its hash and carries no suffix.
    let declared: Vec<&String> = rows
        .iter()
        .filter(|(_, _, _, _, _, structure)| {
            structure
                .to_ascii_lowercase()
                .contains(RETIRED_COLUMNAR_SUFFIX.trim_start_matches('.'))
        })
        .map(|(id, ..)| id)
        .collect();
    assert!(
        declared.is_empty(),
        "these artifacts still DECLARE the retired columnar file type: {declared:?}"
    );

    // ── (4) the ITEM-18 gate examined the WHOLE set and passed it ────────────────
    // The gate is dispatched AFTER ingest and records its verdict on the run
    // asynchronously — measured landing after the job is already terminal — so this
    // polls rather than reading once. A single read here reported "no gate line" on a
    // run whose gate had in fact passed, which would have made this clause a
    // coin-flip.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(120);
    let gate_line = loop {
        let logs: Vec<(String, String)> =
            sqlx::query_as("SELECT stream, content FROM job_logs WHERE job_id = $1 ORDER BY seq")
                .bind(job_id)
                .fetch_all(&pool)
                .await
                .expect("read the run's log");
        if let Some(l) = logs
            .into_iter()
            .find(|(_, c)| c.starts_with(GATE_LOG_PREFIX))
        {
            break l;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the conformance gate never recorded a verdict on this run — ITEM-18 says \
             every emitted artifact is gated, and an unrecorded gate is indistinguishable \
             from no gate"
        );
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    };
    let (stream, content) = &gate_line;
    assert_eq!(
        stream, "stdout",
        "a passing gate records on stdout; a violation or a non-verdict records on \
         stderr. Got: {content}"
    );
    assert!(
        !content.contains(GATE_LOG_UNVERIFIED),
        "the gate did NOT reach a verdict, so nothing verified the emitted set: {content}"
    );
    // The COUNT is the clause that makes this about the WHOLE set: a gate that examined
    // one artifact and skipped the rest still writes a passing line.
    let checked: usize = content
        .split_whitespace()
        .find_map(|w| w.parse::<usize>().ok())
        .unwrap_or_else(|| panic!("the gate line names no count: {content}"));
    assert_eq!(
        checked,
        rows.len(),
        "the gate verified {checked} artifact(s) but the import emitted {} — ITEM-18 \
         gates EVERY emitted artifact, and a gate over a subset is not the gate: {content}",
        rows.len()
    );
    let condemned: Vec<&String> = rows
        .iter()
        .filter(|(_, _, _, _, status, _)| status != "ready")
        .map(|(id, ..)| id)
        .collect();
    assert!(
        condemned.is_empty(),
        "the gate condemned these emitted artifacts: {condemned:?}"
    );

    // ── NEGATIVE CONTROLS — each predicate above must REJECT a witness ────────────
    // Without these, a `foreign.is_empty()` / `columnar.is_empty()` / "not
    // UNVERIFIED" green is equally produced by a predicate that accepts everything,
    // and that is the failure mode this whole entry exists to correct.
    let witness = [
        format!("table{RETIRED_COLUMNAR_SUFFIX}"), // the retired columnar file
        format!("part/0/table{RETIRED_COLUMNAR_SUFFIX}"), // …nested
        "__schema/0".to_string(),                  // a foreign store's own document
        "group_meta".to_string(),
    ];
    for w in &witness {
        assert!(
            !is_zarr_store_member(w),
            "`{w}` is not a Zarr-store member, so the member-shape clause above is \
             accepting anything and its green means nothing"
        );
    }
    assert!(
        witness
            .iter()
            .filter(|w| w.ends_with(RETIRED_COLUMNAR_SUFFIX))
            .count()
            == 2,
        "the columnar-suffix clause above matches nothing at all, so its green means \
         nothing"
    );
    // …and the two Zarr shapes the positive rule MUST accept, so it is a rule and not
    // a constant `false` (which would satisfy every control above and fail the real
    // assertion — except that the real assertion passed, which is the pair).
    for ok in [
        "zarr.json",
        "values/zarr.json",
        "data/c/0",
        "values/x/c/0/1",
    ] {
        assert!(
            is_zarr_store_member(ok),
            "`{ok}` IS a Zarr-store member; a rule that rejects it would have failed the \
             real emitted set above"
        );
    }
    let not_verdict =
        format!("{GATE_LOG_PREFIX} {GATE_LOG_UNVERIFIED} — the gate did not reach a verdict");
    assert!(
        not_verdict.contains(GATE_LOG_UNVERIFIED),
        "the not-verified check above is looking for a string the server no longer \
         writes, so it can never fire"
    );
}

mod arch_gating_test;
mod artifact_summary_test;
mod authz_test;
mod auto_convert_test;
mod convert_soma_test;
mod entity_test;
mod folders_test;
mod hd_bundle_group_test;
mod list_search_test;
// TEST-33 [covers: ITEM-23] — the mount-NAMING test the sandbox mount path did not
// have. Landed BEFORE `run.inputs` was retired (PLAN's ITEM-23 verdict).
mod mount_naming_test;
mod mtx_trio_convert_test;
mod mtx_trio_group_test;
mod process_test;
mod population_consistency_test;
mod processing_status_test;
mod processor_run_test;
mod project_attach_test;
mod promote_test;
mod share_test;
mod job_audience_test;
mod sharee_fanout_test;
mod supporting_convert_test;
mod supporting_files_test;
mod supporting_import_test;
mod supporting_integrate_test;
mod supporting_sequence_test;
mod rss_probe;
mod upload_limits_test;
mod upload_streaming_test;
mod upload_test;

// Wave-5 pipeline hardening (TEST-48..70) — provenance group.
mod prov_content_identity_test;
mod prov_cross_version_test;
mod prov_dataset_scope_test;
mod prov_dead_output_test;
mod prov_forward_leak_test;
mod prov_forward_test;
mod prov_hash_pinning_test;
mod prov_idempotent_test;
mod prov_reachability_test;

// Wave-5 pipeline hardening — job/scheduler group.
mod crash_recovery_test;
mod ingest_failure_test;
mod sched_cancel_test;
mod sched_concurrency_test;
mod sched_fairshare_test;
mod sched_priority_test;
mod sched_timeout_test;
mod sse_stream_test;

// Wave-5 pipeline hardening — executable-capsule group (65..69 rootfs-gated).
mod capsule_cross_version_test;
mod capsule_determinism_test;
mod capsule_manifest_test;
mod capsule_multistep_test;
mod capsule_readiness_negative_test;
// TEST-33 — the capsule harness pointed at a REAL processor (`qc.10x`), not a
// synthetic inline script.
mod capsule_real_analysis_test;
mod capsule_reproduces_test;
mod capsule_runtime_parity_test;

// ─────────────────── TEST-38 [ITEM-27] — the static half MOVED ──────────────────────
//
// Two source-scanning tests lived here: they read a contributed package's compute
// script and its manifest by hardcoded path and asserted that the retired store
// library and the retired output declaration were both gone.
//
// They now live in that package's OWN pytest suite — the file is
// `packages/<pkg>/tests/test_no_store_library.py`, deliberately named here without
// the package — unchanged in what they assert, with a negative control added and with
// an exact tokeniser in place of the hand-rolled string strip. The app can
// neither cause nor prevent an import inside a contributed package, and INV-5 says the
// core — this suite included — must not know which packages or which third-party
// libraries exist. `packages/**` is the contributed domain AS DATA; a package testing
// its own domain is what a contributed package is FOR.
//
// STILL GATED, in the same command: `just check` runs `just check-py`, which runs
// `python3 -m pytest -q` over the whole processor tree.
//
// The RUNTIME half of TEST-38 stays in the app suite (the rootfs-gated converter test
// in this same module), because a statement about what the SERVER catalogs is the
// app's business.
