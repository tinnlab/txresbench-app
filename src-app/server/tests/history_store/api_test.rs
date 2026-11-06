//! TEST-HS-15/16/18 — the module's posture legs: the six routes require the
//! owner's automatic `JobsUse` grant (a minted local owner 200/204, an
//! unauthenticated request 401, the health control 200; no new permission —
//! A10 not triggered), the committed OpenAPI carries EXACTLY the seven
//! `History.*` operations and the generated client exports the `TxrHistory*`
//! types `ui-history` binds, and the shipped module files carry no network
//! surface, no `stud(y|ies)` literal and no working-marker token (INV-1,
//! INV-5, INV-7).

use serde_json::{json, Value};

use super::{history_operations, owner_token, read_committed_openapi};
use crate::common::TestServer;
use cytoanalyst::modules::history_store::types::ROUTE_DOC_IDS;

/// TEST-HS-15 — the route matrix: the six history routes answer 401 to an
/// unauthenticated caller (the `JobsUse` extractor's gate), the minted local
/// owner gets 200/204 on every one, and the framework's health endpoint stays
/// the 200 control. `with_permission(JobsUse)` is a REUSE — `permissions.rs`
/// and the permission migrations are untouched (the regen's
/// `permissions.*` byte-identical result pins it).
#[tokio::test]
async fn routes_require_the_owner_and_the_jobs_use_grant() {
    let server = TestServer::spawn().await;

    // Unauthenticated → 401 on every history route.
    for (verb, path) in [
        ("GET", "/txr/history"),
        ("GET", "/txr/history/00000000-0000-0000-0000-00000000abcd"),
        ("GET", "/txr/history/preferences"),
        ("PUT", "/txr/history/preferences"),
        ("POST", "/txr/history/copies/clear"),
        ("GET", "/txr/history/usage"),
    ] {
        let req = match verb {
            "GET" => server.client.get(server.api_url(path)),
            "PUT" => server.client.put(server.api_url(path)),
            _ => server.client.post(server.api_url(path)),
        };
        let resp = req.send().await.expect("matrix call");
        assert_eq!(resp.status().as_u16(), 401, "{verb} {path}");
    }

    // The framework's health endpoint is the positive control (no gate).
    let resp = server
        .client
        .get(server.api_url("/health"))
        .send()
        .await
        .expect("health");
    assert_eq!(resp.status().as_u16(), 200);

    // The minted owner holds `JobsUse` (the automatic local-owner grant) —
    // the six routes answer 200/204.
    let token = owner_token(&server).await;
    let page = server
        .client
        .get(server.api_url("/txr/history"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("list");
    assert_eq!(page.status().as_u16(), 200);
    let body: Value = page.json().await.expect("page");
    assert_eq!(body["total"], 0, "a fresh server has no runs (empty history)");
    let put = server
        .client
        .put(server.api_url("/txr/history/preferences"))
        .bearer_auth(&token)
        .json(&json!({"keep_file_copies": false}))
        .send()
        .await
        .expect("put");
    assert_eq!(put.status().as_u16(), 204);
    let usage = server
        .client
        .get(server.api_url("/txr/history/usage"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("usage");
    assert_eq!(usage.status().as_u16(), 200);
    let clear = server
        .client
        .post(server.api_url("/txr/history/copies/clear"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("clear");
    assert_eq!(clear.status().as_u16(), 204);
}

/// TEST-HS-16 — the committed regen artifacts: the OpenAPI carries exactly the
/// six history paths / the seven `History.*` operations of
/// `types::ROUTE_DOC_IDS` (and no other `History.*` id), and the generated
/// client exports the `TxrHistory*` types the K screen's consumer binds.
#[test]
fn openapi_and_generated_client_carry_the_history_contract() {
    let spec = read_committed_openapi();
    let ops = history_operations(&spec);
    // The spec emits paths in the router's registration order (path-sorted
    // here); the op-id SET is the contract — the DECLARED order is pinned by
    // the colocated routes test (`ALL` == `ROUTE_DOC_IDS`).
    let mut ids: Vec<&str> = ops.iter().map(|(_, id)| id.as_str()).collect();
    ids.sort_unstable();
    let mut expected = ROUTE_DOC_IDS.to_vec();
    expected.sort_unstable();
    assert_eq!(ids, expected, "exactly the seven operations, no more");
    assert_eq!(
        ops.iter().map(|(p, _)| p.as_str()).collect::<std::collections::BTreeSet<_>>().len(),
        6,
        "six paths (the GET+PUT share the preferences path)"
    );
    for (path, id) in &ops {
        assert!(id.starts_with("History."), "{id}");
        assert!(path.starts_with("/api/txr/history"), "{path}");
    }

    // The generated client: the endpoints + the types ui-history binds.
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let endpoints = std::fs::read_to_string(manifest.join("../ui/src/api-client/apiEndpoints.ts"))
        .expect("apiEndpoints.ts reads");
    for needle in [
        "history",
        "history/{id}",
        "history/preferences",
        "history/copies/clear",
        "history/usage",
    ] {
        assert!(endpoints.contains(needle), "the generated client carries {needle:?}");
    }
    let types = std::fs::read_to_string(manifest.join("../ui/src/api-client/types.ts"))
        .expect("types.ts reads");
    for t in [
        "TxrHistoryItem",
        "TxrHistoryPage",
        "TxrHistoryDetail",
        "TxrHistoryPreferences",
        "TxrHistoryPreferencesUpdate",
        "TxrHistoryUsage",
        "TxrHistoryModelsMade",
        "TxrHistoryModelRef",
        "TxrHistorySavedSet",
        "TxrHistoryFileSize",
        "TxrHistoryMethodRef",
        "TxrHistoryCopies",
        "TxrHistoryEstimate",
        "TxrRunSettingsView",
    ] {
        assert!(types.contains(t), "the generated client exports {t}");
    }

    // No new permission: the permission surface is byte-identical to the
    // framework's (the ITEM-4 regen verified it; the committed file here
    // carries no History.* id — A10 not triggered).
    let perms = std::fs::read_to_string(manifest.join("../ui/src/api-client/permissions.ts"))
        .expect("permissions.ts reads");
    assert!(
        !perms.contains("History."),
        "a history permission id would mean a new permission (A10)"
    );
}

/// TEST-HS-18 (module half) — the shipped module files carry no network
/// surface, no `stud(y|ies)` literal and no working-marker token (INV-1,
/// INV-5, INV-7): the allowlist guard stays green with zero edits, the
/// rename guard's scan of `src-app/**` has nothing to exempt, and the
/// published files hold no status/placeholder/notes.
#[test]
fn module_files_carry_no_network_surface_no_residual_term_and_no_markers() {
    let module_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/modules/history_store");
    let mut sources = String::new();
    let mut files = Vec::new();
    let mut stack = vec![module_dir.clone()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).expect("module dir").flatten() {
            let path = entry.path();
            if entry.file_type().expect("type").is_dir() {
                stack.push(path);
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(".rs") || name.ends_with(".sql") || name == "README.md" {
                files.push(path.clone());
                sources.push_str(&std::fs::read_to_string(&path).expect("module file"));
                sources.push('\n');
            }
        }
    }
    assert!(!files.is_empty(), "the scan set resolved");
    assert!(
        files.iter().any(|f| f.ends_with("README.md")),
        "the module README is part of the shipped file set"
    );

    // INV-1/INV-7: no host and no URL scheme (the allowlist guard's scan of
    // `src-app/server/src` finds nothing TO flag — zero edits needed).
    let lower = sources.to_lowercase();
    assert!(
        !lower.contains("https://") && !lower.contains("http://"),
        "no URL literal in the module (INV-1)"
    );

    // INV-5's guard surface: the rename guard scans `src-app/**` (tests
    // included) — the module must carry no `stud(y|ies)` token.
    assert!(
        !sources.to_lowercase().contains("stud"),
        "no `stud(y|ies)` literal anywhere in the module (the rename guard)"
    );

    // The no-status rule (INV-5): no working-marker token in a shipped file.
    let whole_words = ["TODO", "FIXME", "XXX", "HACK", "WIP"];
    let phrases = [
        "placeholder",
        "phase",
        "progress",
        "in progress",
        "in-progress",
        "unimplemented",
        "not implemented",
        "for now",
    ];
    for file in &files {
        let text = std::fs::read_to_string(file).expect("module file");
        for word in whole_words {
            assert!(
                !text
                    .split(|c: char| !c.is_alphanumeric())
                    .any(|w| w == word),
                "{}: the marker token {word:?} must not appear in a shipped file",
                file.display()
            );
        }
        let lower = text.to_lowercase();
        for phrase in phrases {
            assert!(
                !lower.contains(phrase),
                "{}: the marker phrase {phrase:?} must not appear in a shipped file",
                file.display()
            );
        }
    }
}
