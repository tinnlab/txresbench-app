//! **Who may SEE a job, and who may STOP one.**
//!
//! `799d0cf3` settled who may CREATE a job scoped to a thing: the same gate as every
//! other content mutation on that thing (`require_can_edit` / `require_project_edit`),
//! with owner-only reserved for LIFECYCLE acts. It named — and deliberately did not
//! fix — the companion hole in its own module header: a job row is owned by whoever
//! CREATED it, so once an `edit`-role sharee or a project Editor enqueues a job on
//! someone else's dataset/project, `list_jobs` and `authorize_job` (both purely
//! job-owner scoped) hide that job from the very party whose data it is running on.
//! They see its EFFECT — the derived `Processing`/`Failed` badge — and can do nothing
//! about it, including stop it.
//!
//! ## Why a single-user test could never see this
//!
//! "whose job is this" and "whose dataset is this" are both a `Uuid`, and they are the
//! SAME `Uuid` whenever a user processes their own data — which is every single-user
//! test in this suite. They diverge only through the two routes `799d0cf3` opened.
//! So every assertion here is written across FOUR distinct principals, and the arms
//! are run for BOTH scope kinds (dataset and project) because fixing one and leaving
//! the other is exactly what produced the split `799d0cf3` had to repair.
//!
//! ## The rule these tests pin, and why visibility ≠ stop-authority
//!
//! A job has two kinds of principal, and they get different rights:
//!
//! * **VISIBLE** (list / get / logs / stream) — the job's creator, plus everyone who
//!   may EDIT the thing it acts on, plus admins. Not one of them gains a capability:
//!   every EDIT-holder could have enqueued this exact job themselves. And an editor
//!   NEEDS to see it — "is this dataset busy right now" is the question you must
//!   answer before uploading a file into it or starting a competing run.
//! * **CONTROLLABLE** (stop) — narrower: the job's creator, the OWNER of the thing it
//!   acts on, and admins. Killing an in-flight run is the run's DELETE, and
//!   `799d0cf3` reserved lifecycle acts to the owner. A third-party editor is an
//!   editor of the DATA, not of somebody else's RUN: they may watch it, not end it.
//!
//! A `view`-role sharee / project Viewer gets NEITHER. Readers are not left blind —
//! they keep the surface the product already built for them, and it is deliberately
//! thinner: the dataset's derived processing badge (status only, raw error redacted).
//! Widening `/jobs` to readers would hand them the raw engine log + error text that
//! `enrich_items` and `get_dataset` explicitly redact, i.e. it would UNDO an existing
//! redaction while claiming to fix one.
//!
//! GRADING. Everything invisible answers **404**, never 403: the path parameter is a
//! job id, which an unauthorized caller has no way to learn, so 403 would be an
//! existence oracle. The one 403 in the whole surface is the third-party editor's
//! `stop` — they can already SEE the job, so there is no existence left to protect,
//! and 403 is the honest "you may look, not touch". That 403-vs-404 split is the
//! negative control: it proves the gate still GRADES, so the matrix cannot be
//! satisfied by a gate that admits (or refuses) everyone.

use std::time::Duration;

use serde_json::{json, Value};

use super::{register_user, setup_admin};
use crate::common::sync_probe::SyncProbe;
use crate::common::TestServer;

const WAIT: Duration = Duration::from_secs(10);
/// Long enough that a frame the server DID send would have arrived (the fan-out is
/// in-process and the emit path is a spawn, not a queue), short enough not to crawl.
const SILENCE: Duration = Duration::from_secs(2);

// ------------------------------------------------------------------ fixtures

/// Pin the global concurrency cap at 1 and burn the slot with a long stub job, so
/// every job created afterwards sits `queued` and can be stopped deterministically —
/// no sandbox, no timing race. (Same device as `jobs/stop_sync_test.rs`.)
async fn hold_the_only_slot(server: &TestServer, admin: &str, token: &str) {
    let put = server
        .client
        .put(server.api_url("/job-settings"))
        .bearer_auth(admin)
        .json(&json!({ "max_concurrent_jobs": 1 }))
        .send()
        .await
        .expect("put job settings");
    assert_eq!(put.status().as_u16(), 200, "admin set concurrency=1");

    let resp = server
        .client
        .post(server.api_url("/jobs"))
        .bearer_auth(token)
        .json(&json!({ "job_type": "stub", "name": "holds-the-slot", "params": { "steps": 600 } }))
        .send()
        .await
        .expect("create holding job");
    assert_eq!(resp.status().as_u16(), 201, "holding job created");
}

async fn create_dataset(server: &TestServer, token: &str, name: &str) -> String {
    let resp = server
        .client
        .post(server.api_url("/datasets"))
        .bearer_auth(token)
        .json(&json!({ "name": name }))
        .send()
        .await
        .expect("create dataset");
    assert_eq!(resp.status().as_u16(), 201, "create dataset {name}");
    resp.json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string()
}

async fn share_dataset(server: &TestServer, owner: &str, ds: &str, principal_id: &str, role: &str) {
    let resp = server
        .client
        .post(server.api_url(&format!("/datasets/{ds}/shares")))
        .bearer_auth(owner)
        .json(&json!({ "principal_type": "user", "principal_id": principal_id, "role": role }))
        .send()
        .await
        .expect("share dataset");
    let s = resp.status().as_u16();
    assert!(s == 200 || s == 201, "share dataset role={role} → {s}");
}

async fn create_project(server: &TestServer, token: &str, name: &str) -> String {
    let resp = server
        .client
        .post(server.api_url("/projects"))
        .bearer_auth(token)
        .json(&json!({ "name": name, "description": "" }))
        .send()
        .await
        .expect("create project");
    assert_eq!(resp.status().as_u16(), 201, "create project {name}");
    resp.json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string()
}

/// Offer a project share at `level` WITHOUT accepting it. An invitation is not a
/// grant: `effective_permission` filters `status = 'accepted'`, and the job-list SQL
/// has to copy that clause.
async fn offer_project_share(
    server: &TestServer,
    owner: &str,
    pid: &str,
    recipient_email: &str,
    level: &str,
) {
    let resp = server
        .client
        .post(server.api_url(&format!("/projects/{pid}/shares")))
        .bearer_auth(owner)
        .json(&json!({ "email": recipient_email, "permission_level": level }))
        .send()
        .await
        .expect("offer share");
    assert_eq!(resp.status().as_u16(), 201, "offer project share {level}");
}

/// Share a project at `level` and have the recipient ACCEPT (an unaccepted share
/// confers nothing — `effective_permission` filters `status = 'accepted'`).
async fn share_project(
    server: &TestServer,
    owner: &str,
    pid: &str,
    recipient_token: &str,
    recipient_email: &str,
    level: &str,
) {
    let resp = server
        .client
        .post(server.api_url(&format!("/projects/{pid}/shares")))
        .bearer_auth(owner)
        .json(&json!({ "email": recipient_email, "permission_level": level }))
        .send()
        .await
        .expect("share project");
    assert_eq!(resp.status().as_u16(), 201, "share project {level}");
    let share_id = resp.json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string();
    let acc = server
        .client
        .post(server.api_url(&format!("/project-shares/{share_id}/accept")))
        .bearer_auth(recipient_token)
        .send()
        .await
        .expect("accept share");
    assert_eq!(acc.status().as_u16(), 200, "accept project share");
}

/// Enqueue a job carrying `scope` (`{"dataset_id": …}` or `{"project_id": …}`).
async fn create_scoped_job(server: &TestServer, token: &str, name: &str, scope: &Value) -> String {
    let mut body = json!({ "job_type": "stub", "name": name, "params": { "steps": 600 } });
    for (k, v) in scope.as_object().expect("scope object") {
        body[k] = v.clone();
    }
    let resp = server
        .client
        .post(server.api_url("/jobs"))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .expect("create scoped job");
    assert_eq!(resp.status().as_u16(), 201, "scoped job {name} created");
    resp.json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string()
}

// ------------------------------------------------------------------ probes

async fn status_of(server: &TestServer, token: &str, path: &str) -> u16 {
    server
        .client
        .get(server.api_url(path))
        .bearer_auth(token)
        .send()
        .await
        .expect("GET")
        .status()
        .as_u16()
}

async fn stop_status(server: &TestServer, token: &str, job: &str) -> u16 {
    server
        .client
        .post(server.api_url(&format!("/jobs/{job}/stop")))
        .bearer_auth(token)
        .send()
        .await
        .expect("stop")
        .status()
        .as_u16()
}

/// The caller's whole job list (per_page maxed) as `(ids, total)`.
async fn list_jobs(server: &TestServer, token: &str, query: &str) -> (Vec<String>, i64) {
    let body: Value = server
        .client
        .get(server.api_url(&format!("/jobs?per_page=100{query}")))
        .bearer_auth(token)
        .send()
        .await
        .expect("list jobs")
        .json()
        .await
        .expect("list json");
    let ids = body["jobs"]
        .as_array()
        .expect("jobs array")
        .iter()
        .map(|j| j["job"]["id"].as_str().expect("job id").to_string())
        .collect();
    (ids, body["total"].as_i64().expect("total"))
}

/// Everything the READ surface says about one job, for one principal.
#[derive(Debug, PartialEq, Eq)]
struct ReadReach {
    listed: bool,
    get: u16,
    logs: u16,
    stream: u16,
}

async fn read_reach(server: &TestServer, token: &str, job: &str) -> ReadReach {
    let (ids, _) = list_jobs(server, token, "").await;
    ReadReach {
        listed: ids.iter().any(|i| i == job),
        get: status_of(server, token, &format!("/jobs/{job}")).await,
        logs: status_of(server, token, &format!("/jobs/{job}/logs")).await,
        stream: status_of(server, token, &format!("/jobs/{job}/stream")).await,
    }
}

fn visible() -> ReadReach {
    ReadReach { listed: true, get: 200, logs: 200, stream: 200 }
}
fn invisible() -> ReadReach {
    ReadReach { listed: false, get: 404, logs: 404, stream: 404 }
}

// ============================== the dataset arm ==============================

/// Four principals × the whole job-scoped read surface, for a job an `edit`-sharee
/// ran on somebody ELSE's dataset.
///
/// The headline assertion is the dataset OWNER's: their data, their compute, their
/// badge — and before this, a 404 on every one of these.
#[tokio::test]
async fn dataset_scoped_job_is_visible_to_the_datasets_editors_not_its_readers() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (owner, _owner_id) = register_user(&server, "dsvowner").await;
    let (eddie, eddie_id) = register_user(&server, "dsveddie").await;
    let (edna, edna_id) = register_user(&server, "dsvedna").await;
    let (viv, viv_id) = register_user(&server, "dsvviv").await;
    let (stranger, _stranger_id) = register_user(&server, "dsvstranger").await;

    let ds = create_dataset(&server, &owner, "shared-ds").await;
    share_dataset(&server, &owner, &ds, &eddie_id, "edit").await;
    share_dataset(&server, &owner, &ds, &edna_id, "edit").await;
    share_dataset(&server, &owner, &ds, &viv_id, "view").await;

    hold_the_only_slot(&server, &admin, &owner).await;
    // The creator is an edit-SHAREE, not the dataset owner — the divergence.
    let job = create_scoped_job(&server, &eddie, "eddies-run", &json!({ "dataset_id": ds })).await;

    assert_eq!(read_reach(&server, &eddie, &job).await, visible(), "the job's CREATOR sees it");
    assert_eq!(
        read_reach(&server, &owner, &job).await,
        visible(),
        "THE REGRESSION: the DATASET OWNER can see the job running on their own data"
    );
    assert_eq!(
        read_reach(&server, &edna, &job).await,
        visible(),
        "a second edit-sharee sees it (an editor must know the dataset is busy)"
    );
    assert_eq!(
        read_reach(&server, &viv, &job).await,
        invisible(),
        "a VIEW-role sharee gets the badge, never the job (raw logs/error stay redacted)"
    );
    assert_eq!(read_reach(&server, &stranger, &job).await, invisible(), "a stranger sees nothing");
    assert_eq!(read_reach(&server, &admin, &job).await, visible(), "an admin sees everything");
}

/// STOP is an AUTHORITY question, and its answer is NOT the visibility answer.
///
/// Every principal here is checked against the same job in the same state, so the
/// only variable is who is asking. The third-party editor's **403** is the load-
/// bearing assertion: it is simultaneously the proof that stop is narrower than
/// sight, and the negative control proving the gate grades rather than blanket-
/// accepting or blanket-refusing.
#[tokio::test]
async fn stopping_a_dataset_job_is_the_owners_and_the_creators_right_only() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (owner, _owner_id) = register_user(&server, "dssowner").await;
    let (eddie, eddie_id) = register_user(&server, "dsseddie").await;
    let (edna, edna_id) = register_user(&server, "dssedna").await;
    let (viv, viv_id) = register_user(&server, "dssviv").await;
    let (stranger, _stranger_id) = register_user(&server, "dssstranger").await;

    let ds = create_dataset(&server, &owner, "stop-ds").await;
    share_dataset(&server, &owner, &ds, &eddie_id, "edit").await;
    share_dataset(&server, &owner, &ds, &edna_id, "edit").await;
    share_dataset(&server, &owner, &ds, &viv_id, "view").await;

    hold_the_only_slot(&server, &admin, &owner).await;
    let scope = json!({ "dataset_id": ds });
    // Three sibling jobs so each ALLOWED principal acts on a fresh, non-terminal row.
    let j_owner = create_scoped_job(&server, &eddie, "for-owner", &scope).await;
    let j_creator = create_scoped_job(&server, &eddie, "for-creator", &scope).await;
    let j_admin = create_scoped_job(&server, &eddie, "for-admin", &scope).await;

    // --- refused, on a job nobody has touched yet ---
    assert_eq!(
        stop_status(&server, &viv, &j_owner).await,
        404,
        "a view sharee cannot stop what they cannot see"
    );
    assert_eq!(stop_status(&server, &stranger, &j_owner).await, 404, "a stranger → 404");
    assert_eq!(
        stop_status(&server, &edna, &j_owner).await,
        403,
        "a THIRD-PARTY EDITOR may watch the run but not end it — 403, not 404, \
         because they can already see it"
    );
    // …and the refusal was real: the job is still stoppable afterwards.
    assert_eq!(
        stop_status(&server, &owner, &j_owner).await,
        200,
        "THE REGRESSION: the DATASET OWNER can stop a job running on their own data"
    );

    assert_eq!(stop_status(&server, &eddie, &j_creator).await, 200, "the creator stops their own");
    assert_eq!(stop_status(&server, &admin, &j_admin).await, 200, "an admin stops any");
}

// ============================== the project arm ==============================

/// The identical hole on the other scope kind. Fixing one arm and leaving the other
/// is what produced the split `799d0cf3` had to repair, so the project arm asserts
/// the SAME rule with the same shape — including the third-party Editor's 403.
#[tokio::test]
async fn project_scoped_job_follows_the_same_rule_for_sight_and_for_stop() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (owner, _owner_id) = register_user(&server, "pjvowner").await;
    let (ed1, _ed1_id) = register_user(&server, "pjved1").await;
    let (ed2, _ed2_id) = register_user(&server, "pjved2").await;
    let (viewer, _viewer_id) = register_user(&server, "pjvviewer").await;
    let (stranger, _stranger_id) = register_user(&server, "pjvstranger").await;
    // An INVITED editor who never accepted. An invitation is not a grant, and the
    // job-list SQL is a hand-copy of `effective_permission`'s `status = 'accepted'`
    // clause — the exact shape of predicate that `799d0cf3` caught drifting. Without
    // this principal the whole matrix passes with that clause deleted (mutation M13).
    let (invited, _invited_id) = register_user(&server, "pjvinvited").await;

    let pid = create_project(&server, &owner, "shared-project").await;
    share_project(&server, &owner, &pid, &ed1, "pjved1@cyto.test", "editor").await;
    share_project(&server, &owner, &pid, &ed2, "pjved2@cyto.test", "editor").await;
    share_project(&server, &owner, &pid, &viewer, "pjvviewer@cyto.test", "viewer").await;
    offer_project_share(&server, &owner, &pid, "pjvinvited@cyto.test", "editor").await;

    hold_the_only_slot(&server, &admin, &owner).await;
    let scope = json!({ "project_id": pid });
    let job = create_scoped_job(&server, &ed1, "ed1s-run", &scope).await;
    let j_owner = create_scoped_job(&server, &ed1, "for-owner", &scope).await;

    assert_eq!(read_reach(&server, &ed1, &job).await, visible(), "the creator sees it");
    assert_eq!(
        read_reach(&server, &owner, &job).await,
        visible(),
        "THE REGRESSION: the PROJECT OWNER sees a job running in their project"
    );
    assert_eq!(
        read_reach(&server, &ed2, &job).await,
        visible(),
        "THE REGRESSION: a co-EDITOR sees the other editor's project job"
    );
    assert_eq!(read_reach(&server, &viewer, &job).await, invisible(), "a project Viewer → 404");
    assert_eq!(read_reach(&server, &stranger, &job).await, invisible(), "a stranger → 404");
    assert_eq!(
        read_reach(&server, &invited, &job).await,
        invisible(),
        "an editor share that was OFFERED but never ACCEPTED confers nothing — the \
         same principal accepts below and becomes visible, so this is not a \
         registration accident"
    );
    // Positive control for the clause above: accepting flips exactly this principal.
    let acc = server
        .client
        .post(server.api_url(&format!("/projects/{pid}/shares")))
        .bearer_auth(&owner)
        .json(&json!({ "email": "pjvinvited@cyto.test", "permission_level": "editor" }))
        .send()
        .await
        .expect("re-offer");
    if acc.status().as_u16() == 201 {
        let sid = acc.json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string();
        let a = server
            .client
            .post(server.api_url(&format!("/project-shares/{sid}/accept")))
            .bearer_auth(&invited)
            .send()
            .await
            .expect("accept");
        assert_eq!(a.status().as_u16(), 200, "accept the re-offered share");
        assert_eq!(
            read_reach(&server, &invited, &job).await,
            visible(),
            "the SAME user, after ACCEPTING, sees the job — so the refusal above was \
             the pending status, not a broken fixture"
        );
    }

    assert_eq!(stop_status(&server, &viewer, &j_owner).await, 404, "Viewer cannot stop");
    assert_eq!(stop_status(&server, &stranger, &j_owner).await, 404, "stranger cannot stop");
    assert_eq!(
        stop_status(&server, &ed2, &j_owner).await,
        403,
        "a co-Editor may watch the run but not end it"
    );
    assert_eq!(
        stop_status(&server, &owner, &j_owner).await,
        200,
        "the PROJECT OWNER can stop a job in their project"
    );
}

/// The project jobs panel (`?project_id=`) is the surface this was built for, and it
/// showed each member only their own rows. Assert the panel and the unfiltered list
/// agree, and that the FILTER still filters (a second project's job is excluded) —
/// otherwise "the owner now sees more" could be satisfied by the filter collapsing.
#[tokio::test]
async fn project_jobs_panel_shows_every_members_job_and_still_filters_by_project() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (owner, _o) = register_user(&server, "pjpowner").await;
    let (ed, _e) = register_user(&server, "pjped").await;

    let a = create_project(&server, &owner, "project-a").await;
    let b = create_project(&server, &owner, "project-b").await;
    share_project(&server, &owner, &a, &ed, "pjped@cyto.test", "editor").await;

    hold_the_only_slot(&server, &admin, &owner).await;
    let in_a = create_scoped_job(&server, &ed, "editors-job-in-a", &json!({ "project_id": a })).await;
    let in_b = create_scoped_job(&server, &owner, "owners-job-in-b", &json!({ "project_id": b })).await;

    let (ids, total) = list_jobs(&server, &owner, &format!("&project_id={a}")).await;
    assert!(ids.contains(&in_a), "the owner's panel for A shows the EDITOR's job");
    assert!(!ids.contains(&in_b), "the ?project_id= filter still excludes project B's job");
    assert_eq!(
        total,
        ids.len() as i64,
        "the panel's COUNT matches the rows it returned — a widened list must widen \
         its total by exactly the same predicate, or the pager lies"
    );
}

// ======================= list integrity + drift guards =======================

/// A list that grows a new SOURCE of rows is where a duplicated or skipped row
/// appears. Two hazards, both asserted:
///
/// 1. **Duplication** — a job matching by BOTH routes (its creator is also an editor
///    of its scope) must appear ONCE. A `JOIN` over `job_scope` would emit it twice
///    and inflate `total` with it.
/// 2. **Page drift** — `ORDER BY created_at DESC` alone is not a total order, and
///    these rows are created inside the same transaction-less burst, so ties are
///    likely. Paging a non-deterministic order silently repeats one row and drops
///    another. Walking every page and comparing the union to the single-page read is
///    what catches it.
#[tokio::test]
async fn the_widened_list_neither_duplicates_nor_drops_a_row_across_pages() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (owner, _o) = register_user(&server, "lstowner").await;
    let (eddie, eddie_id) = register_user(&server, "lsteddie").await;

    let ds = create_dataset(&server, &owner, "list-ds").await;
    share_dataset(&server, &owner, &ds, &eddie_id, "edit").await;
    hold_the_only_slot(&server, &admin, &owner).await;

    let scope = json!({ "dataset_id": ds });
    let mut expected = vec![];
    for i in 0..5 {
        // Alternate the creator: the owner's own rows match by ownership, the
        // sharee's by scope — and the sharee's OWN rows match by BOTH.
        let who = if i % 2 == 0 { &eddie } else { &owner };
        expected.push(create_scoped_job(&server, who, &format!("j{i}"), &scope).await);
    }

    for token in [&owner, &eddie] {
        let (all, total) = list_jobs(&server, token, "").await;
        let mut uniq = all.clone();
        uniq.sort();
        uniq.dedup();
        assert_eq!(uniq.len(), all.len(), "no job appears twice in one page");
        assert_eq!(total, all.len() as i64, "total equals the rows actually returned");
        for id in &expected {
            assert!(all.contains(id), "every scoped job is listed");
        }

        // Walk the pages at per_page=2 and compare the union to the single read.
        let mut walked: Vec<String> = vec![];
        for page in 1..=((total + 1) / 2 + 1) {
            let body: Value = server
                .client
                .get(server.api_url(&format!("/jobs?per_page=2&page={page}")))
                .bearer_auth(token)
                .send()
                .await
                .expect("page")
                .json()
                .await
                .expect("page json");
            for j in body["jobs"].as_array().expect("jobs") {
                walked.push(j["job"]["id"].as_str().unwrap().to_string());
            }
        }
        let mut walked_uniq = walked.clone();
        walked_uniq.sort();
        walked_uniq.dedup();
        assert_eq!(
            walked_uniq.len(),
            walked.len(),
            "paging repeated a row — the list ORDER is not a total order"
        );
        let mut single = all.clone();
        single.sort();
        assert_eq!(walked_uniq, single, "paging dropped or added a row vs the single-page read");
    }
}

/// **The list predicate and the per-job gate must agree.**
///
/// They are two separate implementations of one question — the list is SQL, the gate
/// is Rust calling `require_can_edit` / `effective_permission` — and `799d0cf3`'s
/// second finding was a hand-copied predicate that had silently drifted from its
/// original. This asserts the invariant instead of trusting a reader to notice:
/// for every principal, `job ∈ GET /jobs` **iff** `GET /jobs/{id}` is 200.
#[tokio::test]
async fn a_job_is_listed_exactly_when_it_can_be_opened() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (owner, _o) = register_user(&server, "drfowner").await;
    let (eddie, eddie_id) = register_user(&server, "drfeddie").await;
    let (viv, viv_id) = register_user(&server, "drfviv").await;
    let (stranger, _s) = register_user(&server, "drfstranger").await;

    let ds = create_dataset(&server, &owner, "drift-ds").await;
    share_dataset(&server, &owner, &ds, &eddie_id, "edit").await;
    share_dataset(&server, &owner, &ds, &viv_id, "view").await;
    let pid = create_project(&server, &owner, "drift-project").await;
    share_project(&server, &owner, &pid, &eddie, "drfeddie@cyto.test", "editor").await;
    share_project(&server, &owner, &pid, &viv, "drfviv@cyto.test", "viewer").await;

    hold_the_only_slot(&server, &admin, &owner).await;
    let jobs = vec![
        create_scoped_job(&server, &eddie, "d-job", &json!({ "dataset_id": ds })).await,
        create_scoped_job(&server, &eddie, "p-job", &json!({ "project_id": pid })).await,
        // A SCOPE-LESS job: matched by ownership alone, so nobody but its creator
        // (and an admin) may see it — the case a scope-only predicate would drop.
        create_scoped_job(&server, &eddie, "no-scope", &json!({})).await,
    ];

    let mut any_visible = false;
    let mut any_hidden = false;
    for (who, token) in [
        ("owner", &owner),
        ("editor/creator", &eddie),
        ("viewer", &viv),
        ("stranger", &stranger),
        ("admin", &admin),
    ] {
        let (listed, _) = list_jobs(&server, token, "").await;
        for job in &jobs {
            let in_list = listed.contains(job);
            let opens = status_of(&server, token, &format!("/jobs/{job}")).await == 200;
            assert_eq!(
                in_list, opens,
                "{who}: job {job} is listed={in_list} but openable={opens} — the SQL \
                 predicate and the per-job gate disagree"
            );
            any_visible |= in_list;
            any_hidden |= !in_list;
        }
    }
    // Negative controls: the invariant is trivially true if everything is visible to
    // everyone, or if nothing is visible to anyone.
    assert!(any_visible, "some principal saw some job");
    assert!(any_hidden, "some principal was refused some job");

    // TEST-13 (H-1, #147) — extend the same lock-step to a REMOVED ACCOUNT MEMBER.
    //
    // `resolve_job_reach`'s dataset arm calls `DatasetRepository::access`, which now
    // requires current account membership on the creator branch. `list_visible_to`'s
    // `d.owner_id = $1` arm is a SECOND implementation of that same question in SQL,
    // so if only one of them moved, a removed member's job would be LISTED but not
    // OPENABLE — exactly the drift this test exists to catch, on the exact condition
    // this branch changes.
    let (rmt, rm_id) = register_user(&server, "drfremoved").await;
    let rm = uuid::Uuid::parse_str(&rm_id).unwrap();
    let pool = super::pool_for(&server).await;

    // A second dataset, moved into an ORG account, whose CREATOR is `rm` and whose
    // account `rm` is a member of. Reach therefore rests on the dataset-owner arm —
    // not on a share, and not on the job-creator short-circuit (the job below is
    // owned by someone else, deliberately: `jobs.owner_id` is a separate, filed
    // defect and must not confound this assertion).
    let ds2 = create_dataset(&server, &owner, "drift-removed-ds").await;
    let ds2_uuid = uuid::Uuid::parse_str(&ds2).unwrap();
    // The org is owned by someone else and `rm` is a plain `member`, so the removal
    // below is a state the shipped API can actually reach (removing a sole owner is
    // refused by the LAST_OWNER guard).
    let org = crate::account::make_org_account(
        &pool,
        "DriftLab",
        uuid::Uuid::parse_str(&_o).unwrap(),
    )
    .await;
    crate::account::add_member(&pool, org, rm, "member").await;
    crate::account::move_dataset_to_account(&pool, ds2_uuid, org).await;
    sqlx::query("UPDATE datasets SET owner_id = $1 WHERE id = $2")
        .bind(rm)
        .bind(ds2_uuid)
        .execute(&pool)
        .await
        .unwrap();

    let rm_job = uuid::Uuid::new_v4();
    sqlx::query(
        "INSERT INTO jobs (id, owner_id, job_type, name, status, params, created_at, \
                           priority_class, resource_class) \
         VALUES ($1, $2, 'stub', 'rm-job', 'running', '{}', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'normal', 'cpu-sandbox')",
    )
    .bind(rm_job)
    .bind(uuid::Uuid::parse_str(&_o).unwrap())
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO job_scope (job_id, scope_kind, scope_id) VALUES ($1, 'dataset', $2)")
        .bind(rm_job)
        .bind(ds2_uuid)
        .execute(&pool)
        .await
        .unwrap();

    let rm_job_s = rm_job.to_string();
    let (listed_before, _) = list_jobs(&server, &rmt, "").await;
    let opens_before = status_of(&server, &rmt, &format!("/jobs/{rm_job_s}")).await == 200;
    assert_eq!(
        listed_before.contains(&rm_job_s),
        opens_before,
        "removed-member lock-step (before): listed={} but openable={opens_before}",
        listed_before.contains(&rm_job_s),
    );
    assert!(
        opens_before,
        "precondition: a CURRENT member who created the dataset can see the job \
         running on it — without this the after-half would pass vacuously"
    );

    sqlx::query("DELETE FROM account_members WHERE account_id = $1 AND user_id = $2")
        .bind(org)
        .bind(rm)
        .execute(&pool)
        .await
        .unwrap();

    let (listed_after, _) = list_jobs(&server, &rmt, "").await;
    let opens_after = status_of(&server, &rmt, &format!("/jobs/{rm_job_s}")).await == 200;
    assert_eq!(
        listed_after.contains(&rm_job_s),
        opens_after,
        "removed-member lock-step (after): listed={} but openable={opens_after} — the \
         SQL predicate and the per-job gate disagree on the removed-member condition",
        listed_after.contains(&rm_job_s),
    );
    assert!(
        !opens_after,
        "H-1: a removed member must not keep reach over jobs running on the dataset \
         they created in the account"
    );
}

// ================================ sync arm ==================================

/// Sight without notification is a stale list. `RealJobSyncSink` addressed every
/// `SyncEntity::Job` frame to `Audience::owner(job.owner_id)`, so the moment the
/// dataset owner can SEE a sharee's job, they are looking at a row nothing will ever
/// tell them changed. The frame must reach the same audience the list does.
#[tokio::test]
async fn a_job_frame_reaches_everyone_the_job_is_visible_to() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (owner, _o) = register_user(&server, "syncowner").await;
    let (eddie, eddie_id) = register_user(&server, "synceddie").await;

    let ds = create_dataset(&server, &owner, "sync-ds").await;
    share_dataset(&server, &owner, &ds, &eddie_id, "edit").await;
    hold_the_only_slot(&server, &admin, &owner).await;

    let mut owner_probe = SyncProbe::open(&server, &owner).await;
    let job = create_scoped_job(&server, &eddie, "sync-run", &json!({ "dataset_id": ds })).await;

    // `expect_event_for` (not `expect_event`): the owner also owns the slot-holding
    // job, so the stream carries unrelated `job` frames; the assertion is about THIS id.
    let f = owner_probe.expect_event_for("job", "create", &job, WAIT).await;
    assert_eq!(
        f.id, job,
        "the DATASET OWNER is told a job appeared on their dataset — the row they can \
         now list must not sit stale until a manual reload"
    );
}

/// **Test the tie, not the happy path.**
///
/// The page-walk above creates its rows through the API, so their `created_at` values
/// differ at microsecond resolution and `ORDER BY created_at DESC` alone happens to be
/// a total order — which means that test would pass with or without the `id`
/// tiebreaker, and cannot certify it. Ties are not exotic in production (a burst of
/// enqueues from one dispatch, a bulk retry, a restored backup), and this list now
/// interleaves several creators' rows, so it meets them more often than the old one.
///
/// So make the tie REAL: write six rows sharing one `created_at` straight into the
/// table, then page them. Without the tiebreaker, Postgres is free to order the tied
/// rows differently per query, and the walk repeats one row and drops another.
#[tokio::test]
async fn paging_rows_that_share_a_created_at_repeats_nothing_and_drops_nothing() {
    let server = TestServer::spawn().await;
    setup_admin(&server).await;
    let (token, user_id) = register_user(&server, "tieowner").await;
    let pool = super::pool_for(&server).await;
    let owner = uuid::Uuid::parse_str(&user_id).unwrap();

    let stamp = chrono::Utc::now();
    let mut expected: Vec<String> = vec![];
    for i in 0..6 {
        let id = uuid::Uuid::new_v4();
        sqlx::query(
            "INSERT INTO jobs (id, owner_id, job_type, name, status, params, created_at, \
                               priority_class, resource_class)
             VALUES ($1, $2, 'stub', $3, 'completed', '{}', $4, 'normal', 'cpu-sandbox')",
        )
        .bind(id)
        .bind(owner)
        .bind(format!("tied-{i}"))
        .bind(stamp)
        .execute(&pool)
        .await
        .expect("insert tied job");
        expected.push(id.to_string());
    }
    expected.sort();

    let mut walked: Vec<String> = vec![];
    for page in 1..=3 {
        let body: Value = server
            .client
            .get(server.api_url(&format!("/jobs?per_page=2&page={page}")))
            .bearer_auth(&token)
            .send()
            .await
            .expect("page")
            .json()
            .await
            .expect("page json");
        for j in body["jobs"].as_array().expect("jobs") {
            walked.push(j["job"]["id"].as_str().unwrap().to_string());
        }
    }
    let mut seen = walked.clone();
    seen.sort();
    seen.dedup();
    assert_eq!(
        seen.len(),
        walked.len(),
        "paging repeated a row across pages — ORDER BY created_at DESC is not a total \
         order over rows that share a created_at; it needs the id tiebreaker"
    );
    assert_eq!(seen, expected, "paging dropped or invented a row");

    // …and the ORDER itself, which is the property the pager actually rests on.
    //
    // Repeat-and-drop is what a non-total order CAUSES, but Postgres is only PERMITTED
    // to reorder tied rows between queries, not obliged to — three identical plans over
    // an untouched heap usually return them identically, so the assertions above pass
    // with or without the tiebreaker and cannot certify it. (Mutation M10 survived them.)
    // The order is observable directly, though: these ids are random v4s, so heap order
    // is not descending-id order except by a 1-in-720 fluke. Asserting the sequence is
    // strictly descending by (created_at, id) tests the contract itself rather than one
    // symptom of breaking it — and it is the honest assertion, because "the pager is
    // safe" simply MEANS "the order is total".
    let descending = walked.windows(2).all(|w| w[0] > w[1]);
    assert!(
        descending,
        "tied rows came back in {walked:?} — not descending by id, so the list order is \
         not a total order and paging it is unsound"
    );
}

/// **The GROUP arm of both predicates.**
///
/// Every other test here shares to a USER principal, which leaves the `principal_type
/// = 'group'` branch of `list_visible_to` — and the whole group leg of the sync
/// audience UNION — running in production and asserted nowhere. That branch is also
/// where the last bug of this family lived: `799d0cf3`'s second finding was a group
/// predicate that resolved through `user_groups` alone while every sibling filtered to
/// ACTIVE groups, so DISABLING a group revoked one gate and not another.
///
/// So: reach the job through a group `edit` share, then have an administrator DISABLE
/// the group and watch the same principal go blind. Deactivation is a revocation, and
/// it has to mean the same thing here as everywhere else.
#[tokio::test]
async fn a_group_edit_share_grants_sight_and_deactivating_the_group_takes_it_back() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (owner, _o) = register_user(&server, "grpowner").await;
    let (member, member_id) = register_user(&server, "grpmember").await;

    let group_id = {
        let pool = super::pool_for(&server).await;
        let group_id = crate::common::group_create(&pool, "job-vis-group", vec![]).await;
        crate::common::group_assign(
            &pool,
            uuid::Uuid::parse_str(&member_id).expect("member id is a uuid"),
            group_id,
        )
        .await;
        // The HTTP `group_id` string the share route expects.
        group_id.to_string()
    };

    let ds = create_dataset(&server, &owner, "group-shared-ds").await;
    let r = server
        .client
        .post(server.api_url(&format!("/datasets/{ds}/shares")))
        .bearer_auth(&owner)
        .json(&json!({ "principal_type": "group", "principal_id": group_id, "role": "edit" }))
        .send()
        .await
        .expect("group share");
    assert!(matches!(r.status().as_u16(), 200 | 201), "group edit share created");

    hold_the_only_slot(&server, &admin, &owner).await;

    // The frame must reach the group member too — the sync audience's group leg.
    let mut member_probe = SyncProbe::open(&server, &member).await;
    let job = create_scoped_job(&server, &owner, "owners-run", &json!({ "dataset_id": ds })).await;
    let f = member_probe.expect_event_for("job", "create", &job, WAIT).await;
    assert_eq!(f.id, job, "a group edit-sharee is told the job appeared");

    assert_eq!(
        read_reach(&server, &member, &job).await,
        visible(),
        "a group `edit` share reaches the job exactly like a user `edit` share"
    );
    assert_eq!(
        stop_status(&server, &member, &job).await,
        403,
        "…and stops at the same place: they are a third-party editor, not the owner"
    );

    // Deactivate the group. Same user, same share row, no longer an editor.
    {
        let pool = super::pool_for(&server).await;
        crate::common::group_deactivate(
            &pool,
            uuid::Uuid::parse_str(&group_id).expect("group id is a uuid"),
        )
        .await;
    }

    assert_eq!(
        read_reach(&server, &member, &job).await,
        invisible(),
        "DISABLING the group revoked the job too — a revocation must mean the same \
         thing at every gate, which is exactly what 799d0cf3 found drifting"
    );

    // The SYNC audience is a second gate, and it has its own copy of the active-group
    // clause. Without this the clause could be deleted and every assertion above still
    // pass (mutation M19): the ex-member would keep receiving `job` frames for a row
    // that now 404s — notify-and-refetch carries no data, but "job <id> changed" is
    // still something a revoked user should not be told.
    //
    // A FRESH probe, opened after the deactivation: the group edit fans a `session`
    // frame to every member, and that frame is correct — it is what tells their devices
    // to re-bootstrap. Opening after it keeps this assertion about the JOB audience.
    let mut after_probe = SyncProbe::open(&server, &member).await;
    let stopped = stop_status(&server, &owner, &job).await;
    assert_eq!(stopped, 200, "the dataset owner stops the run (a real job transition)");
    after_probe.expect_silence(SILENCE).await;
}

// ========================= the can_stop wire arm ============================

/// The caller's `can_stop` for one job, read off the LIST wire. `None` = the job is
/// not listed for this caller (they cannot see it at all).
async fn listed_can_stop(server: &TestServer, token: &str, job: &str) -> Option<bool> {
    let body: Value = server
        .client
        .get(server.api_url("/jobs?per_page=100"))
        .bearer_auth(token)
        .send()
        .await
        .expect("list jobs")
        .json()
        .await
        .expect("list json");
    body["jobs"]
        .as_array()
        .expect("jobs array")
        .iter()
        .find(|it| it["job"]["id"].as_str() == Some(job))
        .map(|it| {
            it["can_stop"]
                .as_bool()
                .expect("every listed job states can_stop")
        })
}

/// The same fact off the DETAIL wire.
async fn detail_can_stop(server: &TestServer, token: &str, job: &str) -> Option<bool> {
    let resp = server
        .client
        .get(server.api_url(&format!("/jobs/{job}")))
        .bearer_auth(token)
        .send()
        .await
        .expect("get job");
    if resp.status().as_u16() != 200 {
        return None;
    }
    let body: Value = resp.json().await.expect("detail json");
    Some(body["can_stop"].as_bool().expect("detail states can_stop"))
}

/// **A control the server renders must be a control the server honors.**
///
/// `11e622bf` widened SIGHT to a scope's editors while keeping STOP to the creator
/// or the scope OWNER — correct, and it left the third-party editor looking at a
/// Stop button that answers 403. The fix is NOT a second copy of the rule in
/// TypeScript (this sweep has found six hand-copied predicates, every one of them
/// drifted); it is the server STATING the fact, so the frontend renders from an
/// answer rather than re-deriving a question.
///
/// This pins the only thing that makes such a field trustworthy: for every principal
/// who can SEE a job, the `can_stop` the wire states is EXACTLY what `POST
/// /jobs/{id}/stop` goes on to do. A `can_stop` that drifts from the gate is worse
/// than no field at all — it launders a refusal into a promise.
///
/// Each principal probes stop on its OWN sibling job (identically scoped, same
/// state), because a successful stop is terminal and would otherwise change the
/// answer for everyone after it.
#[tokio::test]
async fn can_stop_on_the_wire_is_exactly_what_stop_does() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (owner, _o) = register_user(&server, "cswowner").await;
    let (eddie, eddie_id) = register_user(&server, "csweddie").await;
    let (edna, edna_id) = register_user(&server, "cswedna").await;
    let (viv, viv_id) = register_user(&server, "cswviv").await;
    let (stranger, _s) = register_user(&server, "cswstranger").await;

    let ds = create_dataset(&server, &owner, "canstop-ds").await;
    share_dataset(&server, &owner, &ds, &eddie_id, "edit").await;
    share_dataset(&server, &owner, &ds, &edna_id, "edit").await;
    share_dataset(&server, &owner, &ds, &viv_id, "view").await;
    let pid = create_project(&server, &owner, "canstop-project").await;
    share_project(&server, &owner, &pid, &eddie, "csweddie@cyto.test", "editor").await;
    share_project(&server, &owner, &pid, &edna, "cswedna@cyto.test", "editor").await;
    share_project(&server, &owner, &pid, &viv, "cswviv@cyto.test", "viewer").await;

    hold_the_only_slot(&server, &admin, &owner).await;

    let principals: Vec<(&str, &String)> = vec![
        ("dataset/project OWNER", &owner),
        ("editor + CREATOR", &eddie),
        ("third-party EDITOR", &edna),
        ("viewer", &viv),
        ("stranger", &stranger),
        ("admin", &admin),
    ];

    let mut saw_true = false;
    let mut saw_false = false;
    let mut saw_hidden = false;

    for (scope_name, scope) in [
        ("dataset", json!({ "dataset_id": ds })),
        ("project", json!({ "project_id": pid })),
    ] {
        for (who, token) in &principals {
            // A fresh, identically-scoped, non-terminal sibling per principal.
            let job = create_scoped_job(&server, &eddie, "parity", &scope).await;

            let listed = listed_can_stop(&server, token, &job).await;
            let detail = detail_can_stop(&server, token, &job).await;
            assert_eq!(
                listed, detail,
                "{who} on a {scope_name}-scoped job: the LIST and the DETAIL wire \
                 disagree about can_stop"
            );

            let stopped = stop_status(&server, token, &job).await;
            match listed {
                None => {
                    saw_hidden = true;
                    assert_eq!(
                        stopped, 404,
                        "{who}: a job they cannot see must stay a 404 on stop, never \
                         a graded answer"
                    );
                }
                Some(can) => {
                    let honored = stopped != 403;
                    assert_eq!(
                        can, honored,
                        "{who} on a {scope_name}-scoped job: the wire said \
                         can_stop={can} and POST /stop answered {stopped} — a stated \
                         fact the gate does not honor"
                    );
                    if can {
                        assert_eq!(
                            stopped, 200,
                            "{who}: can_stop=true must mean the stop SUCCEEDS, not \
                             merely that it is not a 403"
                        );
                        saw_true = true;
                    } else {
                        saw_false = true;
                    }
                }
            }
        }
    }

    // Negative controls: the invariant is trivially satisfied by a field that is
    // always true, always false, or by a surface where nothing is hidden.
    assert!(saw_true, "some principal was told can_stop=true");
    assert!(saw_false, "some principal was told can_stop=false — the field GRADES");
    assert!(saw_hidden, "some principal could not see the job at all");
}

/// The batched list grader and the per-job gate are TWO implementations of the
/// stop rule — `controllable_subset` is SQL, `resolve_job_reach` is Rust — and
/// `799d0cf3`'s second finding was exactly a hand-copied predicate that drifted from
/// its original. `a_job_is_listed_exactly_when_it_can_be_opened` holds the SIGHT pair
/// to each other; this holds the STOP pair, across both scope kinds and a scope-less
/// job (the row a scope-only predicate would silently drop).
#[tokio::test]
async fn the_batched_stop_grader_and_the_per_job_gate_agree() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (owner, _o) = register_user(&server, "bsgowner").await;
    let (eddie, eddie_id) = register_user(&server, "bsgeddie").await;
    // The THIRD-PARTY editor. Without her every principal in this matrix is either
    // blind or in control, so `can_stop` is `false` for nobody and the `any_false`
    // negative control fails — which is exactly how this fixture gap was found, and
    // the reason the control is there. She is the ONE principal the two
    // implementations can disagree about.
    let (edna, edna_id) = register_user(&server, "bsgedna").await;
    let (viv, viv_id) = register_user(&server, "bsgviv").await;
    let (stranger, _s) = register_user(&server, "bsgstranger").await;

    let ds = create_dataset(&server, &owner, "grader-ds").await;
    share_dataset(&server, &owner, &ds, &eddie_id, "edit").await;
    share_dataset(&server, &owner, &ds, &edna_id, "edit").await;
    share_dataset(&server, &owner, &ds, &viv_id, "view").await;
    let pid = create_project(&server, &owner, "grader-project").await;
    share_project(&server, &owner, &pid, &eddie, "bsgeddie@cyto.test", "editor").await;
    share_project(&server, &owner, &pid, &edna, "bsgedna@cyto.test", "editor").await;
    share_project(&server, &owner, &pid, &viv, "bsgviv@cyto.test", "viewer").await;

    hold_the_only_slot(&server, &admin, &owner).await;
    let jobs = vec![
        create_scoped_job(&server, &eddie, "d-job", &json!({ "dataset_id": ds })).await,
        create_scoped_job(&server, &eddie, "p-job", &json!({ "project_id": pid })).await,
        create_scoped_job(&server, &eddie, "no-scope", &json!({})).await,
    ];

    let mut any_true = false;
    let mut any_false = false;
    for (who, token) in [
        ("owner", &owner),
        ("editor/creator", &eddie),
        ("third-party editor", &edna),
        ("viewer", &viv),
        ("stranger", &stranger),
        ("admin", &admin),
    ] {
        for job in &jobs {
            let listed = listed_can_stop(&server, token, job).await;
            let detail = detail_can_stop(&server, token, job).await;
            assert_eq!(
                listed, detail,
                "{who}: the batched list grader and the per-job gate disagree on \
                 can_stop for {job}"
            );
            match listed {
                Some(true) => any_true = true,
                Some(false) => any_false = true,
                None => {}
            }
        }
    }
    assert!(any_true, "some principal controls some job");
    assert!(any_false, "some principal sees a job they may not stop");
}
