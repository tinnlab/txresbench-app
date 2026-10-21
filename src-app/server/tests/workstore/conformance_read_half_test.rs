//! **The READ half of the conformance gate** (ITEM-18 / DEC-12).
//!
//! `jobs::conformance` writes `artifacts.status = 'failed'` when an artifact's bytes
//! disagree with its declared `structure`. `conformance_gate_test` proves that WRITE.
//! This file proves the READ: that the flag then changes what the server does.
//!
//! It did not, and that is the defect. Every serve, stage and promote path loaded the
//! row with `CatalogRepository::get` and used it, so DEC-12's accepted cost — "a
//! non-conforming artifact is briefly live before the job flags it" — described a window
//! that never closed. The gate condemned artifacts and they kept serving, kept staging
//! into jobs, and kept being promotable into first-class Datasets.
//!
//! ## What is asserted, and the shape every case takes
//!
//! A condemnation splits the surfaces in two, and the split is the design:
//!
//! | surface | a `failed` artifact |
//! |---|---|
//! | `GET /artifacts/{id}` (metadata) | **200**, `status: "failed"` — where the owner MEETS it |
//! | `GET /projects/{id}/artifacts` (listing) | **listed** — an invisible artifact cannot be acted on |
//! | `GET /projects/{id}/catalog` → `artifacts` | **listed**, but it defines no AXIS |
//! | `GET /artifacts/{id}/data[/{*member}]` | **409 `ARTIFACT_NOT_CONFORMING`** |
//! | `DELETE /projects/{id}/artifacts/{id}` | **204** — the owner's remedy, never blocked |
//! | job input staging (`materialize_inputs`) | **refused**, nothing staged |
//!
//! Every case carries **both legs**: a `ready` artifact on the same URL, in the same
//! fixture, still answering 200 with the exact bytes. Without that a 409 could equally
//! mean "the fixture never seeded" or "the route is not mounted", and the assertions
//! would hold with the whole byte plane removed.
//!
//! The refusal status is asserted as **409, never 404 and never merely "not 200"**. 404
//! would contradict this suite's own listing assertions — the row is right there in the
//! catalog — and would tell a user whose viewer went blank nothing about why. The one
//! place 404 IS correct is the stranger's probe, and that case is here too, because the
//! ORDER of the authz check and the conformance check is what decides it: a 409 confirms
//! the row exists, so checking conformance first would turn the byte routes into a
//! cross-tenant existence oracle.

use serde_json::{json, Value};
use uuid::Uuid;

use cytoanalyst::modules::workstore::catalog::models::NewArtifact;
use cytoanalyst::modules::workstore::catalog::repository::CatalogRepository;
use cytoanalyst::modules::workstore::object_store::ObjectStore;

use super::{
    create_member_token, create_project, new_artifact, pool_for, server_store, setup_admin,
};
use crate::common::TestServer;

/// The error code every refusal carries. Named once, from the same constant the server
/// exports, so a rename cannot leave this suite asserting a string nothing produces.
const ERR: &str = cytoanalyst::modules::workstore::consume::ERR_NOT_CONFORMING;

const GOOD_BYTES: &[u8] = b"an artifact whose bytes match what it declares";
const BAD_BYTES: &[u8] = b"an artifact the conformance gate condemned";
const MEMBER_PATH: &str = "c/0";
const MEMBER_BYTES: &[u8] = b"one member of a multi-file artifact";

/// One project seeded with three real artifacts + real blobs in the server's own store:
/// a single-file control that stays `ready`, a single-file artifact the test condemns,
/// and a multi-file one the test condemns (so the `/data/{*member}` route is exercised
/// as well as `/data`).
struct Fixture {
    project: Uuid,
    good: Uuid,
    bad: Uuid,
    bad_multi: Uuid,
}

async fn seed(server: &TestServer, token: &str, name: &str) -> Fixture {
    let project = create_project(server, token, name).await;
    let store = server_store(server);
    let repo = CatalogRepository::new(pool_for(server).await);

    let good_key = store.put(GOOD_BYTES).await.expect("put good blob");
    let bad_key = store.put(BAD_BYTES).await.expect("put bad blob");
    let multi = store
        .put_prefix(&[(MEMBER_PATH.to_string(), MEMBER_BYTES.to_vec())])
        .await
        .expect("put multi blob");

    let good = repo
        .insert_artifact(&new_artifact(project, "good", good_key.as_str(), false))
        .await
        .expect("seed good");
    let bad = repo
        .insert_artifact(&new_artifact(project, "bad", bad_key.as_str(), false))
        .await
        .expect("seed bad");
    let bad_multi = repo
        .insert_artifact(&new_artifact(
            project,
            "bad_multi",
            multi.object_key.as_str(),
            true,
        ))
        .await
        .expect("seed bad_multi");

    Fixture {
        project,
        good: good.id,
        bad: bad.id,
        bad_multi: bad_multi.id,
    }
}

/// Flip an artifact to exactly the status the conformance gate writes, through the same
/// repository call `conformance::apply_verdict` uses — so this suite condemns an
/// artifact the way production does rather than by writing SQL of its own.
async fn condemn(server: &TestServer, id: Uuid) {
    let flipped = CatalogRepository::new(pool_for(server).await)
        .set_status(id, cytoanalyst::modules::jobs::conformance::STATUS_FAILED)
        .await
        .expect("set_status");
    assert!(flipped, "the fixture row must exist to be condemned");
}

/// `(status, body)` for a GET with a bearer token.
async fn get(server: &TestServer, token: &str, path: &str) -> (u16, Vec<u8>) {
    let r = server
        .client
        .get(server.api_url(path))
        .bearer_auth(token)
        .send()
        .await
        .unwrap_or_else(|e| panic!("GET {path}: {e}"));
    let status = r.status().as_u16();
    (status, r.bytes().await.expect("body").to_vec())
}

/// Assert a byte-route response is the 409 refusal, naming the error CODE rather than
/// matching on prose (the message is documentation; the code is the contract).
fn assert_refused(label: &str, status: u16, body: &[u8]) {
    assert_eq!(
        status,
        409,
        "{label}: a condemned artifact's bytes must be refused with 409 — not 404 (the \
         row is listed and its metadata reads 200, so denying existence here would make \
         the API contradict itself), and not 200. body: {}",
        String::from_utf8_lossy(body)
    );
    let v: Value = serde_json::from_slice(body).unwrap_or_else(|e| {
        panic!(
            "{label}: the refusal must be a structured error, got {e}: {}",
            String::from_utf8_lossy(body)
        )
    });
    let code = v["error_code"].as_str();
    assert_eq!(code, Some(ERR), "{label}: refusal carries {ERR}; body {v}");
}

// ─────────────────────────────────────────────────────────────────────────────────
// The byte plane refuses; the metadata + listing surfaces do not.
// ─────────────────────────────────────────────────────────────────────────────────

/// The headline: after the gate condemns an artifact, its BYTES stop being served — on
/// both byte routes — while the row itself stays fully visible so the owner can act.
///
/// The `ready` control (`good`) is read on the SAME URL shape, before and after the
/// condemnation, so the 409 is attributable to the one row that changed and not to the
/// route, the fixture, or the token.
#[tokio::test]
async fn a_condemned_artifact_is_refused_by_the_byte_plane_and_stays_visible() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let fx = seed(&server, &admin, "read half").await;

    // ── BEFORE: every artifact serves. This is the window DEC-12 accepts, and asserting
    //    it here is what makes every refusal below a CHANGE rather than a constant.
    for (label, id, want) in [
        ("good", fx.good, GOOD_BYTES),
        ("bad (still ready)", fx.bad, BAD_BYTES),
    ] {
        let (s, b) = get(&server, &admin, &format!("/artifacts/{id}/data")).await;
        assert_eq!(s, 200, "{label}: serves before condemnation");
        assert_eq!(b.as_slice(), want, "{label}: exact bytes");
    }
    let (s, b) = get(
        &server,
        &admin,
        &format!("/artifacts/{}/data/{MEMBER_PATH}", fx.bad_multi),
    )
    .await;
    assert_eq!(s, 200, "bad_multi member serves before condemnation");
    assert_eq!(b.as_slice(), MEMBER_BYTES);

    // ── THE GATE'S WRITE.
    condemn(&server, fx.bad).await;
    condemn(&server, fx.bad_multi).await;

    // ── AFTER — the read half. Both byte routes refuse.
    let (s, b) = get(&server, &admin, &format!("/artifacts/{}/data", fx.bad)).await;
    assert_refused("GET /artifacts/{id}/data", s, &b);
    assert_ne!(
        b.as_slice(),
        BAD_BYTES,
        "the refusal must not carry the bytes it refused"
    );

    let (s, b) = get(
        &server,
        &admin,
        &format!("/artifacts/{}/data/{MEMBER_PATH}", fx.bad_multi),
    )
    .await;
    assert_refused("GET /artifacts/{id}/data/{member}", s, &b);
    assert_ne!(b.as_slice(), MEMBER_BYTES, "member bytes must not leak");

    // ── POSITIVE CONTROL, read AFTER the condemnations: the untouched artifact still
    //    serves its exact bytes on the same route. Without this leg, a gate that refused
    //    EVERYTHING would pass every assertion above.
    let (s, b) = get(&server, &admin, &format!("/artifacts/{}/data", fx.good)).await;
    assert_eq!(s, 200, "the ready artifact is unaffected");
    assert_eq!(b.as_slice(), GOOD_BYTES);

    // ── The owner can still SEE the condemned artifact. This is not a nicety: the flag's
    //    only remedy is inspect-then-delete, and an artifact hidden from both the metadata
    //    read and the listing is one the user cannot find, cannot diagnose, and cannot
    //    remove — its blob would be pinned by a row nobody can reach.
    let (s, b) = get(&server, &admin, &format!("/artifacts/{}", fx.bad)).await;
    assert_eq!(
        s, 200,
        "metadata stays readable — this is where the user meets the failure"
    );
    let row: Value = serde_json::from_slice(&b).expect("artifact json");
    assert_eq!(
        row["status"], "failed",
        "…and the wire says WHY, so the FE can label it"
    );

    let (s, b) = get(
        &server,
        &admin,
        &format!("/projects/{}/artifacts", fx.project),
    )
    .await;
    assert_eq!(s, 200);
    let listed: Value = serde_json::from_slice(&b).expect("listing json");
    let ids: Vec<&str> = listed
        .as_array()
        .expect("listing is an array")
        .iter()
        .filter_map(|a| a["id"].as_str())
        .collect();
    assert!(
        ids.contains(&fx.bad.to_string().as_str()),
        "the condemned artifact stays LISTED (hiding it strands the row + its blob); got {ids:?}"
    );
    assert!(
        ids.contains(&fx.good.to_string().as_str()),
        "positive control: the listing is not empty for an unrelated reason"
    );
}

/// The remedy must never be blocked. DELETE resolves the artifact by id, so any filter
/// applied to that lookup would make a condemned artifact permanently undeletable — and
/// its blob permanently unreclaimable, since the GC keep-set is (correctly) unfiltered
/// and holds any blob a row references.
#[tokio::test]
async fn a_condemned_artifact_is_still_deletable_by_its_owner() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let fx = seed(&server, &admin, "read half delete").await;
    condemn(&server, fx.bad).await;

    let r = server
        .client
        .delete(server.api_url(&format!("/projects/{}/artifacts/{}", fx.project, fx.bad)))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("delete");
    assert_eq!(
        r.status().as_u16(),
        204,
        "a condemned artifact is exactly the one a user needs to delete"
    );

    let repo = CatalogRepository::new(pool_for(&server).await);
    assert!(
        repo.get_any_status(fx.bad).await.unwrap().is_none(),
        "the row is gone"
    );
    // POSITIVE CONTROL: the sibling survives, so the 204 was a targeted delete and not a
    // cascade that would have made this assertion true either way.
    assert!(
        repo.get_any_status(fx.good).await.unwrap().is_some(),
        "the ready artifact is untouched"
    );
}

/// **The ordering property, as a security assertion.** A `409` confirms the row exists.
/// So the byte routes must run their tenancy gate FIRST and answer a stranger with the
/// scope's own `404` — otherwise condemning an artifact would hand every user an oracle
/// for whether an arbitrary artifact id is real.
///
/// The positive control is the owner on the SAME id getting `409`: it proves the row is
/// genuinely condemned, so the stranger's `404` is the gate answering and not the
/// artifact having quietly vanished.
#[tokio::test]
async fn a_condemned_artifact_answers_a_stranger_with_404_not_409() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let fx = seed(&server, &admin, "read half oracle").await;
    condemn(&server, fx.bad).await;

    let (_outsider_id, outsider) = create_member_token(&server, &admin, "conf_outsider").await;

    for (label, id) in [("condemned", fx.bad), ("ready", fx.good)] {
        let (s, _) = get(&server, &outsider, &format!("/artifacts/{id}/data")).await;
        assert_eq!(
            s, 404,
            "{label}: a user outside the project must not learn the artifact exists — and \
             the two ids must answer IDENTICALLY, or the status itself is the oracle"
        );
        let (s, _) = get(&server, &outsider, &format!("/artifacts/{id}")).await;
        assert_eq!(s, 404, "{label}: same for the metadata route");
    }

    // POSITIVE CONTROL: the owner does get the 409, so the row really is condemned.
    let (s, b) = get(&server, &admin, &format!("/artifacts/{}/data", fx.bad)).await;
    assert_refused("owner control", s, &b);
}

/// A condemned KEY ARTIFACT stops defining a project axis, while its row stays in the
/// same response.
///
/// `axes[].length` is `structure.n` — read off the very declaration the gate proved the
/// bytes disagree with — and an axis entry carries no status field, so a condemned key
/// artifact would publish a cardinality the project does not have, as an ordinary fact,
/// with nothing on the wire marking it suspect.
#[tokio::test]
async fn the_catalog_drops_a_condemned_axis_but_keeps_its_row() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let project = create_project(&server, &admin, "read half axes").await;
    let store = server_store(&server);
    let repo = CatalogRepository::new(pool_for(&server).await);

    // Two KEY artifacts, distinct identities, distinct labels — so dropping one is
    // observable as a name disappearing rather than as a count changing.
    async fn key_artifact(
        store: &impl ObjectStore,
        repo: &CatalogRepository,
        project: Uuid,
        output_id: &str,
        axis: &str,
        n: i64,
        bytes: &[u8],
    ) -> Uuid {
        let object_key = store
            .put(bytes)
            .await
            .expect("put key blob")
            .as_str()
            .to_string();
        let mut a: NewArtifact = new_artifact(project, output_id, &object_key, false);
        a.content_hash = object_key.clone();
        a.structure = json!({ "encoding": "zarr_v3", "axis": axis, "n": n });
        a.meta = json!({ "is_axis_index": true });
        repo.insert_artifact(&a)
            .await
            .expect("seed key artifact")
            .id
    }
    let good_axis = key_artifact(
        &store,
        &repo,
        project,
        "good_axis",
        "alpha",
        7,
        b"alpha index bytes",
    )
    .await;
    let bad_axis = key_artifact(
        &store,
        &repo,
        project,
        "bad_axis",
        "beta",
        999,
        b"beta index bytes",
    )
    .await;

    // BEFORE: both axes are published (so the absence below is a change).
    let (s, b) = get(&server, &admin, &format!("/projects/{project}/catalog")).await;
    assert_eq!(s, 200);
    let cat: Value = serde_json::from_slice(&b).unwrap();
    let names = |c: &Value| -> Vec<String> {
        c["axes"]
            .as_array()
            .expect("axes array")
            .iter()
            .map(|a| a["name"].as_str().unwrap_or_default().to_string())
            .collect()
    };
    let before = names(&cat);
    assert!(
        before.contains(&"alpha".to_string()) && before.contains(&"beta".to_string()),
        "both axes publish before the condemnation; got {before:?}"
    );

    condemn(&server, bad_axis).await;

    let (s, b) = get(&server, &admin, &format!("/projects/{project}/catalog")).await;
    assert_eq!(s, 200);
    let cat: Value = serde_json::from_slice(&b).unwrap();
    let after = names(&cat);
    assert_eq!(
        after,
        vec!["alpha".to_string()],
        "the condemned key artifact no longer declares an axis; got {after:?}"
    );
    // …and no axis reports the condemned artifact's cardinality under ANY name.
    assert!(
        cat["axes"]
            .as_array()
            .unwrap()
            .iter()
            .all(|a| a["length"].as_i64() != Some(999)),
        "the condemned declaration's `n` must not survive under another label: {}",
        cat["axes"]
    );

    // The ROW is still in the same response — dropping the axis is not hiding the
    // artifact; the user has to be able to see it to delete it.
    let listed: Vec<&str> = cat["artifacts"]
        .as_array()
        .expect("artifacts array")
        .iter()
        .filter_map(|a| a["id"].as_str())
        .collect();
    assert!(
        listed.contains(&bad_axis.to_string().as_str()),
        "the condemned key artifact stays listed; got {listed:?}"
    );
    assert!(
        listed.contains(&good_axis.to_string().as_str()),
        "positive control: the artifact list is populated"
    );
}

// ─────────────────────────────────────────────────────────────────────────────────
// Job input staging — the surface where consuming a condemned artifact is worst.
// ─────────────────────────────────────────────────────────────────────────────────

/// A job must never consume an artifact the gate condemned.
///
/// This is the consequence that motivates the whole read half. Staging non-conforming
/// bytes does not crash: the processor reads them by the `structure` the gate disproved,
/// the run SUCCEEDS, it emits plausible numbers, and the provenance record says the run
/// consumed a legitimate input. Nobody downstream can tell. A job that fails with a
/// reason is strictly better than that.
///
/// Driven through `materialize_inputs` — the chokepoint both job-create paths funnel
/// through (mirrors `jobs::materialize_rejects_cross_user_dataset_file_ref`) — with the
/// SAME spec, owner, store and pool for both legs, so the only difference is `status`.
#[tokio::test]
async fn job_input_staging_refuses_a_condemned_artifact() {
    use cytoanalyst::modules::sandbox::inputs::materialize_inputs;
    use cytoanalyst::modules::sandbox::spec::AnalysisSpec;

    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let owner = admin_user_id(&server, &admin).await;
    let fx = seed(&server, &admin, "read half staging").await;
    let pool = pool_for(&server).await;
    let store = server_store(&server);

    // The declared `sandbox_subpath` is deliberately kept and deliberately IGNORED:
    // ITEM-23 derives an artifact-backed mount name from the ARTIFACT (sanitized slot +
    // a suffix read off `structure.encoding`), so this fixture's opaque artifact stages
    // at `/inputs/x`, not at the string below. Nothing here asserts a literal name —
    // the positive leg reads back the path the materializer itself reported.
    let spec_for = |id: Uuid| {
        AnalysisSpec::parse(&json!({
            "language": "python", "script": "print(1)",
            "inputs": [{ "slot": "x", "artifact_ref": id, "sandbox_subpath": "x.bin" }],
        }))
        .expect("spec parses")
    };

    // ── POSITIVE LEG: the ready artifact stages, and stages its real bytes. Without
    //    this the refusal below could equally mean the fixture, the store or the spec is
    //    broken.
    let ok_dir = server
        .data_dir()
        .join("sandboxes")
        .join(Uuid::new_v4().to_string())
        .join("inputs");
    let staged = materialize_inputs(&spec_for(fx.good), &ok_dir, owner, &[], &pool, &store)
        .await
        .expect("a ready artifact stages");
    assert_eq!(staged.len(), 1);
    assert_eq!(
        std::fs::read(&staged[0].host_path).expect("staged file"),
        GOOD_BYTES,
        "the ready leg staged the real bytes"
    );
    assert_eq!(
        staged[0].host_path,
        ok_dir.join("x"),
        "…under the name DERIVED from the artifact (slot `x`, `encoding: opaque` ⇒ no \
         suffix), not the `sandbox_subpath` the spec declared"
    );

    // ── NEGATIVE LEG: condemn, then stage the SAME artifact id. It must refuse, and
    //    nothing may reach the workspace.
    condemn(&server, fx.good).await;
    let bad_dir = server
        .data_dir()
        .join("sandboxes")
        .join(Uuid::new_v4().to_string())
        .join("inputs");
    let err = materialize_inputs(&spec_for(fx.good), &bad_dir, owner, &[], &pool, &store)
        .await
        .expect_err("a condemned artifact must not be staged into a job");
    assert_eq!(
        err.error_code(),
        ERR,
        "the job fails with the conformance reason, not a generic error: {err}"
    );
    // Asserted over the WHOLE directory, not one guessed filename. Naming a literal here
    // was the vacuous shape: the refusal is what must hold, so a name the runner never
    // chooses (`x.bin` after ITEM-23) would make this pass with the guard removed.
    let leaked: Vec<String> = std::fs::read_dir(&bad_dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    assert!(
        leaked.is_empty(),
        "no byte of a condemned artifact may reach the sandbox workspace, under ANY \
         name — found {leaked:?}"
    );

    let _ = std::fs::remove_dir_all(&ok_dir);
    let _ = std::fs::remove_dir_all(&bad_dir);
}

/// The acting admin's user id (staging authorizes against the JOB OWNER).
async fn admin_user_id(server: &TestServer, token: &str) -> Uuid {
    let (s, b) = get(server, token, "/auth/me").await;
    assert_eq!(s, 200, "GET /auth/me");
    let me: Value = serde_json::from_slice(&b).expect("me json");
    Uuid::parse_str(
        me["id"]
            .as_str()
            .or_else(|| me["user"]["id"].as_str())
            .expect("user id"),
    )
    .expect("uuid")
}
