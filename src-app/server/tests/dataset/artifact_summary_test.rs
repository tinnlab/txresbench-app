//! TEST — `GET /datasets/artifact-summaries`: how many artifacts each visible
//! dataset holds and what is in there, in ONE batched read.
//!
//! Covers the four things the endpoint claims and one thing it must NOT do:
//!   1. the EMPTY case — a COVERED dataset holding nothing is PRESENT with a zero
//!      count (DEC-3), so that absence carries exactly one meaning ("past the cap");
//!   2. the COUNTED POPULATION (DEC-7) — `intermediate` / non-`ready` / `hidden`
//!      rows are excluded, each as its own negative control beside a counted row;
//!   3. GROUPING (DEC-8) — per-datatype counts + sizes, most-numerous first, with the
//!      group's BEST-DECLARED-then-most-recent member as its representative (the rule
//!      on `DatasetArtifactGroup`; it was `size_bytes DESC, id` until task #148), and
//!      the totals covering groups past the cap;
//!   4. the ACL — a foreign dataset is invisible, a SHARED one is visible.
//!
//! The datatype ids here are deliberately neutral (`probe/*`): this endpoint holds no
//! opinion about which types exist, so a fixture naming real ones would be asserting
//! something the code does not do.

use serde_json::{json, Value};
use sqlx::SqlitePool;
use uuid::Uuid;

use cytoanalyst::modules::dataset::models::{DECL_MAX_ARRAY_ITEMS, DECL_MAX_KEYS, GROUP_CAP};

use super::hardening_common::{admin_user_id, pool_for};
use super::{create_dataset, create_user, login, setup_admin};
use crate::common::TestServer;

/// One artifact row against a dataset, carrying BOTH producer declarations.
/// Everything the endpoint reads is a column, so the fixture writes columns — no
/// ingest, no blobs, no sandbox.
#[allow(clippy::too_many_arguments)]
async fn insert_declared_artifact(
    pool: &SqlitePool,
    dataset_id: Uuid,
    output_id: &str,
    datatype: &str,
    // The LOGICAL size — what the summary displays. The fixture deliberately leaves
    // `stored_bytes` at its 0 default and writes ONLY this column, so a summary that
    // went back to summing stored bytes would report 0 and every total below would
    // fail. That is the point: these assertions cannot pass under both readings.
    logical_bytes: i64,
    structure: Value,
    meta: Value,
    role: &str,
    status: &str,
    hidden: bool,
) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO artifacts
             (id, dataset_id, output_id, datatype, object_key, is_multifile, content_hash,
              structure, meta, role, status, logical_bytes, hidden)
         VALUES ($1, $2, $3, $4, $5, false, $5, $6, $7, $8, $9, $10, $11)",
    )
    .bind(id)
    .bind(dataset_id)
    .bind(output_id)
    .bind(datatype)
    .bind(format!("sha256:{}", "0".repeat(64)) + &id.to_string())
    .bind(structure)
    .bind(meta)
    .bind(role)
    .bind(status)
    .bind(logical_bytes)
    .bind(hidden)
    .execute(pool)
    .await
    .expect("insert artifact row");
    id
}

/// The common case: a row whose `structure` declaration is empty. Kept separate so
/// the tests that are NOT about `structure` read as they did.
#[allow(clippy::too_many_arguments)]
async fn insert_artifact(
    pool: &SqlitePool,
    dataset_id: Uuid,
    output_id: &str,
    datatype: &str,
    logical_bytes: i64,
    meta: Value,
    role: &str,
    status: &str,
    hidden: bool,
) -> Uuid {
    insert_declared_artifact(
        pool,
        dataset_id,
        output_id,
        datatype,
        logical_bytes,
        json!({}),
        meta,
        role,
        status,
        hidden,
    )
    .await
}

async fn summaries(server: &TestServer, token: &str) -> Value {
    let resp = server
        .client
        .get(server.api_url("/datasets/artifact-summaries"))
        .bearer_auth(token)
        .send()
        .await
        .expect("artifact-summaries");
    assert_eq!(resp.status().as_u16(), 200, "artifact-summaries → 200");
    resp.json().await.expect("summary json")
}

/// The summary for `ds`, or `None` when the dataset is absent from the response.
fn summary_of<'a>(body: &'a Value, ds: &str) -> Option<&'a Value> {
    body["summaries"]
        .as_array()
        .expect("summaries array")
        .iter()
        .find(|s| s["dataset_id"] == json!(ds))
}

fn group_of<'a>(summary: &'a Value, datatype: &str) -> Option<&'a Value> {
    summary["groups"]
        .as_array()
        .expect("groups array")
        .iter()
        .find(|g| g["datatype"] == json!(datatype))
}

#[tokio::test]
async fn artifact_summaries_group_count_and_exclude_uncounted_rows() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    // `full` holds counted artifacts; `bare` holds NONE; `noise` holds ONLY rows the
    // counted population excludes.
    let full = create_dataset(&server, &admin, "summary-full").await;
    let bare = create_dataset(&server, &admin, "summary-bare").await;
    let noise = create_dataset(&server, &admin, "summary-noise").await;
    let full_id = Uuid::parse_str(&full).unwrap();
    let noise_id = Uuid::parse_str(&noise).unwrap();

    // ── the counted set on `full`: 1 × probe/alpha, 3 × probe/beta ───────────────
    insert_artifact(
        &pool,
        full_id,
        "primary",
        "probe/alpha",
        1_000,
        json!({ "rows": 120, "columns": 36, "nested": { "x": 1 } }),
        "artifact",
        "ready",
        false,
    )
    .await;
    // The beta group's representative is `beta-mid`, and the fixture is arranged so that
    // is a DISCRIMINATING answer: it is neither the first nor the last row inserted,
    // neither the biggest nor the smallest, and not the most recent. It wins on the one
    // thing the rule is actually about — it is the only member that DECLARES a
    // `structure` (`DatasetArtifactGroup`). Every rival rule this code has held, or
    // could plausibly drift back to, names a different row here.
    insert_artifact(
        &pool,
        full_id,
        "beta-biggest",
        "probe/beta",
        900,
        json!({ "label": "biggest" }),
        "artifact",
        "ready",
        false,
    )
    .await;
    insert_declared_artifact(
        &pool,
        full_id,
        "beta-mid",
        "probe/beta",
        500,
        json!({ "dims": [7] }),
        json!({ "label": "beta-mid" }),
        "artifact",
        "ready",
        false,
    )
    .await;
    for (out, size) in [("beta-small", 10_i64)] {
        insert_artifact(
            &pool,
            full_id,
            out,
            "probe/beta",
            size,
            json!({ "label": out }),
            "artifact",
            "ready",
            false,
        )
        .await;
    }

    // ── the excluded rows, one per exclusion, all on `noise` ─────────────────────
    // A POSITIVE control sits beside them so `noise`'s count is a real 1, not a 0 that
    // any broken filter would also produce.
    insert_artifact(
        &pool,
        noise_id,
        "counted",
        "probe/alpha",
        7,
        json!({}),
        "artifact",
        "ready",
        false,
    )
    .await;
    insert_artifact(
        &pool,
        noise_id,
        "viz-only",
        "probe/alpha",
        1_000_000,
        json!({}),
        "intermediate",
        "ready",
        false,
    )
    .await;
    insert_artifact(
        &pool,
        noise_id,
        "not-yet-verified",
        "probe/alpha",
        1_000_000,
        json!({}),
        "artifact",
        "pending",
        false,
    )
    .await;
    insert_artifact(
        &pool,
        noise_id,
        "alternate-encoding",
        "probe/alpha",
        1_000_000,
        json!({}),
        "artifact",
        "ready",
        true,
    )
    .await;

    let body = summaries(&server, &admin).await;

    // ── (1) the EMPTY case: `bare` is PRESENT and reads ZERO (DEC-3) ─────────────
    // Omitting it would make absence mean two things — "holds nothing" and "past the
    // cap, never counted" — and the client cannot tell those apart, so it would print
    // a confident "no artifacts" about a dataset nobody looked at.
    let b = summary_of(&body, &bare).expect(
        "a dataset the read COVERED is present even when it holds nothing — absence is \
         reserved for datasets past the cap",
    );
    assert_eq!(b["artifact_count"], json!(0));
    assert_eq!(b["total_logical_bytes"], json!(0));
    assert_eq!(
        b["groups"].as_array().expect("groups array").len(),
        0,
        "an empty dataset has no groups"
    );

    // ── (3) grouping, ordering, totals, representative ───────────────────────────
    let s = summary_of(&body, &full).expect("full summary");
    assert_eq!(s["artifact_count"], json!(4), "1 alpha + 3 beta");
    assert_eq!(
        s["total_logical_bytes"],
        json!(1_000 + 900 + 500 + 10),
        "the byte total covers every counted artifact"
    );
    let groups = s["groups"].as_array().expect("groups");
    assert_eq!(groups.len(), 2, "two datatypes → two groups");
    assert_eq!(
        groups[0]["datatype"],
        json!("probe/beta"),
        "most-numerous group first (3 beta before 1 alpha)"
    );
    assert_eq!(groups[0]["count"], json!(3));
    assert_eq!(groups[0]["logical_bytes"], json!(900 + 500 + 10));
    assert_eq!(
        groups[0]["representative_output_id"],
        json!("beta-mid"),
        "the group's representative is its BEST-DECLARED member — not the biggest, not \
         the newest, not the first or last inserted"
    );
    assert_eq!(
        groups[0]["representative_meta"],
        json!({ "label": "beta-mid" }),
        "the representative carries the PRODUCER's declaration verbatim, from the SAME \
         row the structure came from"
    );
    assert_eq!(
        groups[0]["representative_structure"],
        json!({ "dims": [7] }),
        "…and that row is the one that declared a structure at all"
    );

    // The compaction is a size rule: a container-valued key is dropped, scalars stay.
    let alpha = group_of(s, "probe/alpha").expect("alpha group");
    assert_eq!(
        alpha["representative_meta"],
        json!({ "rows": 120, "columns": 36 }),
        "`meta` travels compacted — scalars kept, the nested object dropped (DEC-5)"
    );

    // ── (2) the counted population ───────────────────────────────────────────────
    let n = summary_of(&body, &noise).expect("noise summary");
    assert_eq!(
        n["artifact_count"],
        json!(1),
        "only the ready, promotable, non-hidden row counts — the intermediate, the \
         pending and the hidden ones do not"
    );
    assert_eq!(
        n["total_logical_bytes"],
        json!(7),
        "…and the byte total is the counted row's alone (each excluded row is 1 MB, \
         so any leak here is unmistakable)"
    );
    assert_eq!(
        group_of(n, "probe/alpha").expect("alpha group")["representative_output_id"],
        json!("counted"),
        "the representative is drawn from the counted set, not from the larger \
         excluded rows"
    );
}

#[tokio::test]
async fn artifact_summaries_cap_groups_but_not_the_total() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let ds = create_dataset(&server, &admin, "summary-many-types").await;
    let ds_id = Uuid::parse_str(&ds).unwrap();

    // One artifact per datatype, TWICE the cap, so the truncation is unambiguous.
    let kinds = (GROUP_CAP as usize) * 2;
    for i in 0..kinds {
        insert_artifact(
            &pool,
            ds_id,
            &format!("out{i:02}"),
            &format!("probe/t{i:02}"),
            (i as i64) + 1,
            json!({}),
            "artifact",
            "ready",
            false,
        )
        .await;
    }

    let body = summaries(&server, &admin).await;
    let s = summary_of(&body, &ds).expect("summary present");
    assert_eq!(
        s["groups"].as_array().expect("groups").len(),
        GROUP_CAP as usize,
        "the groups are capped"
    );
    assert_eq!(
        s["artifact_count"],
        json!(kinds as i64),
        "the TOTAL still covers every artifact, including the groups past the cap — \
         a count computed from the truncated group list would read {GROUP_CAP}"
    );
    let expected_bytes: i64 = (1..=kinds as i64).sum();
    assert_eq!(
        s["total_logical_bytes"],
        json!(expected_bytes),
        "…and so does the byte total"
    );
}

#[tokio::test]
async fn artifact_summaries_are_scoped_to_what_the_caller_can_see() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let _owner = admin_user_id(&pool).await;

    let private = create_dataset(&server, &admin, "summary-private").await;
    let shared = create_dataset(&server, &admin, "summary-shared").await;
    for ds in [&private, &shared] {
        insert_artifact(
            &pool,
            Uuid::parse_str(ds).unwrap(),
            "primary",
            "probe/alpha",
            5,
            json!({}),
            "artifact",
            "ready",
            false,
        )
        .await;
    }

    let bob_id = create_user(&server, &admin, "sum_bob", "sum_bob@cyto.test").await;
    let resp = server
        .client
        .post(server.api_url(&format!("/datasets/{shared}/shares")))
        .bearer_auth(&admin)
        .json(&json!({ "principal_type": "user", "principal_id": bob_id, "role": "view" }))
        .send()
        .await
        .expect("share");
    assert!(matches!(resp.status().as_u16(), 200 | 201), "share → 2xx");

    let bob = login(&server, "sum_bob").await;
    let body = summaries(&server, &bob).await;
    assert!(
        summary_of(&body, &shared).is_some(),
        "a sharee gets the shared dataset's summary"
    );
    assert!(
        summary_of(&body, &private).is_none(),
        "…and NOT the owner's other dataset — the ACL is the scope"
    );

    // The owner sees both (so "absent" above is about visibility, not about the rows).
    let owner_body = summaries(&server, &admin).await;
    assert!(
        summary_of(&owner_body, &private).is_some() && summary_of(&owner_body, &shared).is_some(),
        "the owner sees both datasets — the private one really does hold a counted \
         artifact, so bob's miss is the ACL and not an empty dataset"
    );
}

#[tokio::test]
async fn artifact_summaries_require_authentication() {
    let server = TestServer::spawn().await;
    let _admin = setup_admin(&server).await;
    let resp = server
        .client
        .get(server.api_url("/datasets/artifact-summaries"))
        .send()
        .await
        .expect("unauthenticated request");
    assert_eq!(
        resp.status().as_u16(),
        401,
        "the endpoint is behind the same capability gate as the list endpoints"
    );
}

#[tokio::test]
async fn artifact_summaries_bound_a_hostile_producer_declaration() {
    // DEC-5 end to end: the compaction is applied on the way OUT, so a producer that
    // stamps an unbounded `meta` cannot make this response unbounded. The unit test
    // in `models.rs` covers the rule; this covers that the endpoint applies it.
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let ds = create_dataset(&server, &admin, "summary-hostile").await;

    let mut meta = serde_json::Map::new();
    for i in 0..(DECL_MAX_KEYS * 5) {
        meta.insert(format!("k{i:03}"), json!(i));
    }
    meta.insert("long".into(), json!("x".repeat(10_000)));
    insert_artifact(
        &pool,
        Uuid::parse_str(&ds).unwrap(),
        "primary",
        "probe/alpha",
        1,
        Value::Object(meta),
        "artifact",
        "ready",
        false,
    )
    .await;

    let body = summaries(&server, &admin).await;
    let s = summary_of(&body, &ds).expect("summary present");
    let representative = &s["groups"][0]["representative_meta"];
    let obj = representative
        .as_object()
        .expect("representative_meta object");
    assert_eq!(
        obj.len(),
        DECL_MAX_KEYS,
        "the key count is bounded on the wire"
    );
    let longest = obj
        .values()
        .filter_map(|v| v.as_str())
        .map(|s| s.chars().count())
        .max()
        .unwrap_or(0);
    assert!(
        longest <= 120,
        "no string value exceeds the char cap (longest was {longest})"
    );
}

/// The producer's `structure` declaration — how to DECODE the bytes — travels with
/// the group, on the same terms as `meta`.
///
/// It is carried because it is the half a preview usually needs: a producer states an
/// array's dimensions there, so a summary built from `meta` alone can describe only
/// one side of a matrix. Everything below is about the declaration ARRIVING and being
/// BOUNDED; nothing here reads a key by name.
#[tokio::test]
async fn artifact_summaries_carry_the_producer_structure_declaration() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let ds = create_dataset(&server, &admin, "summary-structure").await;
    let empty = create_dataset(&server, &admin, "summary-structure-empty").await;
    let ds_id = Uuid::parse_str(&ds).unwrap();
    let empty_id = Uuid::parse_str(&empty).unwrap();

    // Both rows declare a structure AND a meta, so the representative is settled by
    // RECENCY (`DatasetArtifactGroup`) — the row inserted second wins. The loser
    // declares a DIFFERENT dimension list and a different label on purpose: a rule that
    // carried "some row's" structure, or that paired one row's `meta` with another's
    // `structure`, shows up as a mismatch below rather than as a pass.
    //
    // `superseded` is also the LARGER of the two, which is the second thing this pins:
    // byte size no longer decides.
    insert_declared_artifact(
        &pool,
        ds_id,
        "superseded",
        "probe/alpha",
        900,
        json!({ "dims": [1, 1] }),
        json!({ "label": "superseded" }),
        "artifact",
        "ready",
        false,
    )
    .await;
    insert_declared_artifact(
        &pool,
        ds_id,
        "current",
        "probe/alpha",
        10,
        json!({ "dims": [3460, 32738], "spans": ["one", "two"], "opaque": { "x": 1 } }),
        json!({ "label": "current" }),
        "artifact",
        "ready",
        false,
    )
    .await;
    // A SECOND group on the same dataset, with its own declaration — the multi-group
    // case. Each group must carry ITS OWN representative's structure, not the first
    // one's (a fold that reused the previous row would tie them together).
    insert_declared_artifact(
        &pool,
        ds_id,
        "other",
        "probe/beta",
        50,
        json!({ "dims": [7] }),
        json!({}),
        "artifact",
        "ready",
        false,
    )
    .await;
    // …and a row whose producer declared NOTHING structural.
    insert_declared_artifact(
        &pool,
        empty_id,
        "bare",
        "probe/alpha",
        5,
        json!({}),
        json!({}),
        "artifact",
        "ready",
        false,
    )
    .await;

    let body = summaries(&server, &admin).await;

    let s = summary_of(&body, &ds).expect("summary present");
    let alpha = group_of(s, "probe/alpha").expect("alpha group");
    assert_eq!(
        alpha["representative_structure"],
        json!({ "dims": [3460, 32738], "spans": ["one", "two"] }),
        "the REPRESENTATIVE's structure travels, compacted — short all-scalar arrays \
         survive whole and the nested mapping is dropped (DEC-5)"
    );
    assert_eq!(
        alpha["representative_meta"],
        json!({ "label": "current" }),
        "…drawn from the SAME row as the structure, not paired across rows — and from \
         the most RECENT row, which is also the smaller one"
    );
    let beta = group_of(s, "probe/beta").expect("beta group");
    assert_eq!(
        beta["representative_structure"],
        json!({ "dims": [7] }),
        "each group carries its own representative's declaration"
    );

    // The absent case: an empty declaration is `{}`, never null and never missing, so
    // a reader never has to distinguish "no structure" from "no field".
    let e = summary_of(&body, &empty).expect("empty-structure summary present");
    assert_eq!(
        group_of(e, "probe/alpha").expect("alpha group")["representative_structure"],
        json!({}),
        "a producer that declared no structure yields an empty object"
    );
}

/// DEC-5 end to end for the SECOND declaration: a hostile `structure` cannot make the
/// response unbounded, and an over-long array is dropped rather than shortened.
#[tokio::test]
async fn artifact_summaries_bound_a_hostile_structure_declaration() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let ds = create_dataset(&server, &admin, "summary-hostile-structure").await;

    let mut structure = serde_json::Map::new();
    for i in 0..(DECL_MAX_KEYS * 5) {
        structure.insert(format!("k{i:03}"), json!(i));
    }
    structure.insert(
        "aaa_long_list".into(),
        json!(vec![1; DECL_MAX_ARRAY_ITEMS + 1]),
    );
    structure.insert(
        "aab_short_list".into(),
        json!(vec![9; DECL_MAX_ARRAY_ITEMS]),
    );

    insert_declared_artifact(
        &pool,
        Uuid::parse_str(&ds).unwrap(),
        "primary",
        "probe/alpha",
        1,
        Value::Object(structure),
        json!({}),
        "artifact",
        "ready",
        false,
    )
    .await;

    let body = summaries(&server, &admin).await;
    let s = summary_of(&body, &ds).expect("summary present");
    let out = s["groups"][0]["representative_structure"]
        .as_object()
        .expect("representative_structure object");
    assert_eq!(
        out.len(),
        DECL_MAX_KEYS,
        "the key count is bounded on the wire"
    );
    assert_eq!(
        out.get("aab_short_list"),
        Some(&json!(vec![9; DECL_MAX_ARRAY_ITEMS])),
        "an array AT the cap survives whole"
    );
    assert!(
        !out.contains_key("aaa_long_list"),
        "an array past the cap is DROPPED, not truncated — a shortened dimension list \
         would be a false declaration, and this function may only bound"
    );
}
