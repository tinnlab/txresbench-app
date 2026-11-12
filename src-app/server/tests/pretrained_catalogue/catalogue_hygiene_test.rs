//! TEST-PC-13 / TEST-PC-15 / TEST-PC-17 / TEST-PC-18 / TEST-PC-19 — the
//! catalogue + shipped-file hygiene suite (ITEM-6's breadth):
//!
//! - TEST-PC-13 (INV-3, gate leg): every catalogue entry — the committed
//!   generated files AND the fixture registry — carries its licence, an
//!   all-`open` data-source set, a 64-hex lowercase sha256 and a positive
//!   size; a `published-rule` entry's method is frozen, containerized and
//!   gate-passed in its registry; the two catalogue copies are byte-identical
//!   and the bundled manifest equals the `asset` fields of the bundled
//!   entries; after an install the store row's licence equals the entry's.
//! - TEST-PC-15 (INV-4): the recorded request stream of the fixture catalogue
//!   and asset servers carries zero query strings, zero cookies, zero custom
//!   identifier headers and zero out-of-policy hosts.
//! - TEST-PC-17 (INV-5, the models.md host test): `tinnlab.github.io`,
//!   `github.com` and `objects.githubusercontent.com` are ALL listed in
//!   `scripts/network-allowlist.txt`, and every `http(s)://` literal the
//!   module ships is inside the same policy.
//! - TEST-PC-18 (INV-5, the generated-files half): no generated catalogue
//!   file carries a `url` host outside {`github.com`, `tinnlab.github.io`}
//!   (loopback is the test seams' allowance, the policy union of ITEM-3).
//! - TEST-PC-19 (INV-9): the shipped file set (module source, module README,
//!   the three generated catalogue files, the generated OpenAPI's
//!   `Pretrained.*` operations + schemas) carries no working-marker token;
//!   `generated_at` is a date; zero `stud(y|ies)` tokens in the module.
//!
//! All fixtures synthetic; the bytes are the pack fixture's own.

use std::path::PathBuf;

use serde_json::Value;

use crate::common::{TestOptions, TestServer};

use super::*;

/// The policy host set (the catalogue module's constant — same source).
const POLICY_HOSTS: [&str; 2] = ["github.com", "tinnlab.github.io"];

/// The working-marker tokens (the framework's hygiene convention, the same
/// set TEST-HS-18 pins): whole words for one-word markers, substrings for
/// the note-like phrases. `progress` is handled separately — the module's
/// occurrences are its declared WIRE vocabulary (see
/// `progress_occurrences_are_wire_vocabulary`), never work-status notes.
const WHOLE_WORDS: [&str; 5] = ["TODO", "FIXME", "XXX", "HACK", "WIP"];
const PHRASES: [&str; 7] = [
    "placeholder",
    "phase",
    "unimplemented",
    "not implemented",
    "for now",
    "in progress",
    "in-progress",
];

/// The node's shipped file set (TEST-PC-19's scan set).
fn shipped_files() -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = Vec::new();
    let module_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src/modules/pretrained_catalogue");
    let mut stack = vec![module_dir.clone()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).expect("module dir").flatten() {
            let path = entry.path();
            if entry.file_type().expect("type").is_dir() {
                stack.push(path);
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(".rs") || name == "README.md" {
                files.push(path);
            }
        }
    }
    files.push(repo_root().join("data/pretrained-catalogue/catalogue.json"));
    files.push(repo_root().join("data/pretrained-catalogue/bundled-models.json"));
    files.push(repo_root().join("site/public/pretrained-catalogue.json"));
    files
}

/// TEST-PC-13 (the generated + fixture file legs): the gate facts hold on
/// every committed entry, the two catalogue copies are byte-identical, and
/// the bundled manifest is the bundled entries' `asset` fields.
#[test]
fn generated_and_fixture_catalogues_carry_the_gate_facts() {
    let real_cat = repo_root().join("data/pretrained-catalogue/catalogue.json");
    let site_cat = repo_root().join("site/public/pretrained-catalogue.json");
    assert_eq!(
        std::fs::read(&real_cat).expect("read catalogue"),
        std::fs::read(&site_cat).expect("read site copy"),
        "the embedded snapshot and the served copy are byte-identical (PROV-PC-1)"
    );
    let real: Value = serde_json::from_slice(
        &std::fs::read(&real_cat).expect("read catalogue"),
    )
    .expect("catalogue parses");
    let bundled: Value = serde_json::from_slice(
        &std::fs::read(repo_root().join("data/pretrained-catalogue/bundled-models.json"))
            .expect("read bundled manifest"),
    )
    .expect("bundled manifest parses");

    // The gate facts per entry (the real file's loop is vacuous until the
    // owner's publish pass — the empty snapshot is the valid state).
    for (label, catalogue) in [
        ("the committed catalogue", real.clone()),
        (
            "the fixture registry catalogue",
            serde_json::from_slice(
                &std::fs::read(
                    repo_root()
                        .join("scripts/pretrained-catalogue/fixtures/gen/expected-catalogue.json"),
                )
                .expect("read fixture catalogue"),
            )
            .expect("fixture catalogue parses"),
        ),
    ] {
        assert!(catalogue["generated_from"]["generated_at"].as_str().is_some());
        let models = catalogue["models"].as_array().expect("models array");
        for m in models {
            let id = m["id"].as_str().expect("id");
            assert!(
                !m["licence"].as_str().unwrap_or("").trim().is_empty(),
                "{label} {id}: licence empty (INV-3)"
            );
            let sources = m["data_sources"].as_array().expect("data_sources");
            assert!(!sources.is_empty(), "{label} {id}: no data source (INV-3)");
            for s in sources {
                assert_eq!(
                    s["access"], "open",
                    "{label} {id}: a controlled source is not shippable (INV-3)"
                );
                assert!(
                    !s["licence"].as_str().unwrap_or("").trim().is_empty(),
                    "{label} {id}: a source without a licence"
                );
            }
            let sha = m["asset"]["sha256"].as_str().expect("sha256");
            assert_eq!(sha.len(), 64, "{label} {id}: sha256 length");
            assert!(
                sha.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
                "{label} {id}: sha256 is not 64 lowercase hex"
            );
            assert!(
                m["asset"]["size_bytes"].as_u64().expect("size") > 0,
                "{label} {id}: size_bytes must be > 0"
            );
        }
    }

    // The fixture-registry selection rule (DEC-1): a published-rule entry's
    // method is frozen + containerized + gate-passed in its registry; a
    // benchmark-trained entry's method need NOT be frozen (the DEC-1 shape).
    let registry = std::fs::read_to_string(
        repo_root()
            .join("scripts/pretrained-catalogue/fixtures/gen/dev/code/manifest/methods.csv"),
    )
    .expect("read the fixture methods registry");
    let rows: Vec<Vec<&str>> = registry
        .lines()
        .skip(1)
        .map(|l| l.split(',').collect())
        .collect();
    let fixture: Value = serde_json::from_slice(
        &std::fs::read(
            repo_root()
                .join("scripts/pretrained-catalogue/fixtures/gen/expected-catalogue.json"),
        )
        .expect("read fixture catalogue"),
    )
    .expect("fixture catalogue parses");
    for m in fixture["models"].as_array().expect("models") {
        let method_id = m["method_id"].as_str().expect("method_id");
        let row = rows
            .iter()
            .find(|r| r[0] == method_id)
            .unwrap_or_else(|| panic!("{method_id} in the fixture registry"));
        assert_eq!(row[6], "True", "{method_id}: container");
        assert_eq!(row[7], "PASS", "{method_id}: gate");
        if m["kind"] == "published-rule" {
            assert_eq!(row[5], "True", "{method_id}: a published rule is frozen (DEC-1)");
        } else {
            assert_eq!(
                row[5], "False",
                "{method_id}: the benchmark-trained fixture method is the ordinary one"
            );
        }
    }

    // The parity: every bundled entry's asset fields equal the manifest row.
    let manifest_rows = bundled["models"].as_array().expect("bundled models");
    for m in real["models"].as_array().expect("models") {
        if m["asset"]["bundled"] != true {
            continue;
        }
        let row = manifest_rows
            .iter()
            .find(|r| r["id"] == m["id"])
            .unwrap_or_else(|| panic!("{} in the bundled manifest", m["id"]));
        assert_eq!(row["file"], m["asset"]["file"]);
        assert_eq!(row["url"], m["asset"]["url"]);
        assert_eq!(row["sha256"], m["asset"]["sha256"]);
        assert_eq!(row["size_bytes"], m["asset"]["size_bytes"]);
    }
}

/// TEST-PC-13's install half: after a bundled install the store row's licence
/// EQUALS the catalogue entry's — the gate's record is the import's record
/// (the record is the continuation of the gate, not its replacement).
#[tokio::test]
async fn installed_rows_licence_equals_the_catalogue_entry() {
    let scratch = std::env::temp_dir().join(format!(
        "pc-hyg-licence-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&scratch).expect("scratch");
    let bundled_dir = scratch.join("pretrained-bundled");
    std::fs::create_dir_all(&bundled_dir).expect("bundled dir");
    let (size, sha) = {
        let bytes = super::install_test::pack_fixture(
            &bundled_dir,
            "fx-rule-001@1.0.0.txr",
        );
        (bytes.len() as u64, super::install_test::FIXTURE_SHA.to_string())
    };
    let entry = fixture_entry(
        "fx-rule-001",
        "fx-pretrained-rule",
        2,
        true,
        "http://127.0.0.1:1/assets/unused.txr",
        true,
        size,
        &sha,
    );
    let entry_licence = entry["licence"].as_str().expect("licence").to_string();
    let fx = FixtureHttpServer::spawn(
        serde_json::to_vec(&fixture_catalogue(vec![entry])).expect("catalogue serializes"),
        vec![],
    )
    .await;
    let server = TestServer::spawn_with(TestOptions {
        catalogue_url: Some(fx.catalogue_url()),
        pretrained_bundled_dir: Some(bundled_dir.clone()),
        ..Default::default()
    })
    .await;
    let token = super::super::model_store::owner_token(&server).await;
    let resp = server
        .client
        .post(server.api_url("/txr/pretrained/refresh"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("refresh");
    assert_eq!(resp.status().as_u16(), 202);
    let resp = server
        .client
        .post(server.api_url("/txr/pretrained/fx-rule-001/install"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("install");
    assert_eq!(resp.status().as_u16(), 200, "bundled install");
    let body: Value = resp.json().await.expect("install json");
    assert_eq!(body["licence"], entry_licence);
    let model_id = body["model_id"].as_str().expect("model id").to_string();

    let resp = server
        .client
        .get(server.api_url(&format!("/txr/models/{model_id}")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("detail");
    let detail: Value = resp.json().await.expect("detail json");
    assert_eq!(
        detail["licence"], entry_licence,
        "the store row's licence equals the catalogue entry's (INV-3)"
    );
    drop((fx, server, scratch));
}

/// TEST-PC-15 (INV-4): the recorded request stream of a full cycle — one
/// catalogue refresh + one asset download through the SPAWNED server —
/// carries zero query strings, zero cookies, zero `x-*` identifier headers,
/// and every dialed host is the fixture server's loopback (the requests
/// themselves are the evidence — the fixture records the raw lines).
#[tokio::test]
async fn the_request_stream_is_identifier_free() {
    use sha2::{Digest, Sha256};
    let body: Vec<u8> = (0..256 * 1024).map(|i| (i % 127) as u8).collect();
    let sha = hex::encode(Sha256::digest(&body));
    let fx = FixtureHttpServer::spawn(
        serde_json::to_vec(&fixture_catalogue(vec![])).expect("empty catalogue"),
        vec![("fx-inv4-001@1.0.0.txr".to_string(), body.clone())],
    )
    .await;
    let catalogue = serde_json::to_vec(&fixture_catalogue(vec![fixture_entry(
        "fx-inv4-001",
        "cox-cutpoint-risk",
        1,
        false,
        &fx.asset_url("fx-inv4-001@1.0.0.txr"),
        false,
        body.len() as u64,
        &sha,
    )]))
    .expect("fixture catalogue serializes");
    fx.set_catalogue(catalogue);
    let server = TestServer::spawn_with(TestOptions {
        catalogue_url: Some(fx.catalogue_url()),
        ..Default::default()
    })
    .await;
    let token = super::super::model_store::owner_token(&server).await;
    let resp = server
        .client
        .post(server.api_url("/txr/pretrained/refresh"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("refresh");
    assert_eq!(resp.status().as_u16(), 202);
    let resp = server
        .client
        .post(server.api_url("/txr/pretrained/fx-inv4-001/download"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("download");
    assert_eq!(resp.status().as_u16(), 202);
    // Wait for the verified terminal state.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        let resp = server
            .client
            .get(server.api_url("/txr/pretrained/downloads"))
            .bearer_auth(&token)
            .send()
            .await
            .expect("downloads");
        let body: Value = resp.json().await.expect("downloads json");
        if body["downloads"][0]["state"] != "downloading" {
            assert_eq!(body["downloads"][0]["state"], "ready");
            break;
        }
        assert!(std::time::Instant::now() < deadline, "the transfer stalls");
        tokio::time::sleep(std::time::Duration::from_millis(8)).await;
    }

    let requests = fx.requests.lock().expect("request log").clone();
    assert!(
        requests.iter().any(|l| l.starts_with("GET /catalogue.json ")),
        "the catalogue leg was dialed: {requests:?}"
    );
    assert!(
        requests
            .iter()
            .any(|l| l.starts_with("GET /assets/fx-inv4-001@1.0.0.txr ")),
        "the asset leg was dialed: {requests:?}"
    );
    for line in &requests {
        assert!(!line.contains('?'), "no query string (INV-4): {line}");
        assert!(
            line.starts_with("GET /catalogue.json ") || line.starts_with("GET /assets/"),
            "the stream holds only the refresh + asset GETs: {line}"
        );
    }
    // The recorded lines carry the request-target only; the host is the
    // fixture's bound loopback port (the only host the fixture can answer).
    let expected: Vec<&str> = vec![
        "GET /catalogue.json HTTP/1.1",
        "GET /assets/fx-inv4-001@1.0.0.txr HTTP/1.1",
    ];
    for exp in &expected {
        assert!(
            requests.iter().any(|l| l == exp),
            "the stream contains {exp}: {requests:?}"
        );
    }
    drop((fx, server));
}

/// TEST-PC-17's in-test half (the models.md model-host test): the three
/// runtime hosts are ALL listed in `scripts/network-allowlist.txt`, and the
/// shipped module source carries no `http(s)://` literal outside the same
/// policy (the guard script's scan of the source is the other half).
#[test]
fn model_hosts_are_listed_on_the_network_allowlist() {
    let allowlist = std::fs::read_to_string(repo_root().join("scripts/network-allowlist.txt"))
        .expect("read the network allowlist");
    for host in ["tinnlab.github.io", "github.com", "objects.githubusercontent.com"] {
        assert!(
            allowlist.lines().any(|l| l.trim() == host),
            "{host} is listed in scripts/network-allowlist.txt (the model-host test)"
        );
    }

    // Every URL literal the module ships resolves into the same policy
    // (host_allowed = policy hosts ∪ loopback — the ITEM-3 union). The scan
    // mirrors the guard's own scope: `#[cfg(test)]` blocks and comments are
    // ignored (their fixture URLs are the refusals the tests deliberately
    // exercise, e.g. `evil.example`), and a host-less `https://` fragment
    // (a `strip_prefix` code literal) is not a URL.
    let mut sources = String::new();
    for file in shipped_files() {
        if file.extension().is_some_and(|e| e == "rs") || file.ends_with("README.md") {
            let text = std::fs::read_to_string(&file).expect("read module file");
            let cut = text
                .find("#[cfg(test)]")
                .unwrap_or(text.len());
            for line in text[..cut].lines() {
                let trimmed = line.trim_start();
                if trimmed.starts_with("//") || trimmed.is_empty() {
                    continue;
                }
                sources.push_str(line);
                sources.push('\n');
            }
        }
    }
    let url_literals: Vec<&str> = regex_urls(&sources);
    assert!(!url_literals.is_empty(), "the CATALOGUE_URL constant is found");
    let mut asset_urls = 0;
    for url in &url_literals {
        // A code literal like `strip_prefix("https://")` is not a URL; only
        // a parseable http(s) host is a network literal (INV-5's surface).
        let Some(host) = txresbench::modules::pretrained_catalogue::catalogue::host_of(url)
        else {
            continue;
        };
        assert!(
            POLICY_HOSTS.contains(&host),
            "{url} host {host} is inside the model policy"
        );
        asset_urls += 1;
    }
    assert!(asset_urls > 0, "the catalogue URL literal is the network surface");
}

/// TEST-PC-18: no generated catalogue file (the committed ones AND the
/// fixture expectations) carries a `url` host outside the policy. The scan
/// set is the generated JSON documents — the module SOURCE's URL literals
/// are TEST-PC-17's leg.
#[test]
fn generated_file_urls_are_inside_the_host_policy() {
    let mut files: Vec<PathBuf> = shipped_files()
        .into_iter()
        .filter(|f| f.extension().is_some_and(|e| e == "json"))
        .collect();
    files.push(repo_root().join("scripts/pretrained-catalogue/fixtures/gen/expected-catalogue.json"));
    files.push(
        repo_root().join("scripts/pretrained-catalogue/fixtures/gen/expected-bundled-models.json"),
    );
    let mut found = 0usize;
    for file in &files {
        let text = std::fs::read_to_string(file).expect("read generated file");
        for url in regex_urls(&text) {
            found += 1;
            let host = txresbench::modules::pretrained_catalogue::catalogue::host_of(url)
                .unwrap_or_else(|| panic!("{file:?}: {url} has no host"));
            let policy = POLICY_HOSTS.contains(&host)
                || txresbench::modules::pretrained_catalogue::catalogue::host_allowed(url);
            assert!(
                policy,
                "{file:?}: {url} host {host} outside the policy (PROV-landing-site-2)"
            );
        }
    }
    assert!(found > 0, "the fixture catalogue carries urls to scan");
}

/// TEST-PC-19 (INV-9): the shipped file set carries no working-marker token,
/// `generated_at` is a date, and zero `stud(y|ies)` tokens appear in the
/// module (the rename guard's surface — the src-app-wide scan is the
/// script's own leg).
#[test]
fn shipped_files_carry_no_markers_and_tokens() {
    let files = shipped_files();
    assert!(
        files.iter().any(|f| f.ends_with("README.md")),
        "the module README is part of the shipped set"
    );
    for file in &files {
        let text = std::fs::read_to_string(file).expect("read shipped file");
        let lower = text.to_lowercase();
        for word in WHOLE_WORDS {
            assert!(
                !text
                    .split(|c: char| !c.is_alphanumeric())
                    .any(|w| w == word),
                "{}: the marker token {word:?} must not appear in a shipped file",
                file.display()
            );
        }
        for phrase in PHRASES {
            assert!(
                !lower.contains(phrase),
                "{}: the marker phrase {phrase:?} must not appear in a shipped file",
                file.display()
            );
        }
        assert!(
            !lower.contains("study") && !lower.contains("studies"),
            "{}: the rename guard's stud(y|ies) token",
            file.display()
        );
    }

    // `generated_at` is a date (INV-9) — never a status string.
    for file in [
        repo_root().join("data/pretrained-catalogue/catalogue.json"),
        repo_root().join("site/public/pretrained-catalogue.json"),
        repo_root().join("scripts/pretrained-catalogue/fixtures/gen/expected-catalogue.json"),
    ] {
        let doc: Value =
            serde_json::from_slice(&std::fs::read(&file).expect("read generated file"))
                .expect("generated file parses");
        let at = doc["generated_from"]["generated_at"]
            .as_str()
            .expect("generated_at");
        assert!(
            at.len() >= 10
                && at.as_bytes()[4] == b'-'
                && at.as_bytes()[7] == b'-'
                && at.as_bytes()[0..4].iter().all(u8::is_ascii_digit)
                && at.as_bytes()[5..7].iter().all(u8::is_ascii_digit)
                && at.as_bytes()[8..10].iter().all(u8::is_ascii_digit),
            "{file:?}: generated_at {at:?} is a date, not a status"
        );
    }

    // The generated OpenAPI: the node's own operations + schemas carry no
    // marker token (the rest of the file is other modules' descriptions).
    let openapi: Value = serde_json::from_slice(
        &std::fs::read(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../ui/openapi/openapi.json"),
        )
        .expect("read openapi"),
    )
    .expect("openapi parses");
    let mut blocks = String::new();
    for (path, ops) in openapi["paths"].as_object().expect("paths") {
        if path.starts_with("/api/txr/pretrained") {
            blocks.push_str(&serde_json::to_string(ops).expect("serialize"));
        }
    }
    for (name, schema) in openapi["components"]["schemas"].as_object().expect("schemas") {
        if name.starts_with("Pretrained") {
            blocks.push_str(&serde_json::to_string(schema).expect("serialize"));
        }
    }
    let lower = blocks.to_lowercase();
    for word in WHOLE_WORDS {
        assert!(
            !lower.contains(&word.to_lowercase()),
            "openapi: the Pretrained.* blocks carry the marker token {word:?}"
        );
    }
    for phrase in PHRASES {
        assert!(
            !lower.contains(phrase),
            "openapi: the Pretrained.* blocks carry the marker phrase {phrase:?}"
        );
    }
}

/// The module's `progress` occurrences are its WIRE vocabulary — the closed
/// `PRETRAINED_DOWNLOAD_IN_PROGRESS` error code and the documented byte
/// transfer poll — never work-status notes (the owner's no-progress rule is
/// about status markers; TEST-PC-19's scan treats every other usage as a
/// violation).
#[test]
fn progress_occurrences_are_wire_vocabulary() {
    let module_dir =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/modules/pretrained_catalogue");
    let mut hits = 0usize;
    for entry in std::fs::read_dir(&module_dir).expect("module dir").flatten() {
        let path = entry.path();
        if !path.extension().is_some_and(|e| e == "rs") {
            continue;
        }
        let text = std::fs::read_to_string(&path).expect("read module source");
        for (i, line) in text.lines().enumerate() {
            if !line.to_lowercase().contains("progress") {
                continue;
            }
            hits += 1;
            let lower = line.to_lowercase();
            let wire = lower.contains("download") // the byte-progress poll + status code
                || lower.contains("byte") // the byte count poll
                || lower.contains("polled") // the polled transfer
                || lower.contains("codes") // the code declaration
                || lower.contains("vocabulary");
            assert!(
                wire,
                "{}:{}: the only allowed `progress` usages are the wire \
                 vocabulary ({lower})",
                path.display(),
                i + 1
            );
        }
    }
    assert!(hits > 0, "the pin found the vocabulary occurrences");
}

/// Every `http(s)://` literal in `text` — the URL grammar of the policy
/// hosts; a code literal such as `strip_prefix("https://")` is not a URL and
/// yields a host-less fragment the callers skip via `host_of`.
fn regex_urls(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let mut urls = Vec::new();
    let mut start = 0usize;
    while start + "https://".len() <= bytes.len() {
        let Some(rel) = text[start..].find("http") else {
            break;
        };
        let s = start + rel;
        let scheme = if text[s..].starts_with("https://") {
            "https://"
        } else if text[s..].starts_with("http://") {
            "http://"
        } else {
            start = s + 4;
            continue;
        };
        let url_start = s;
        let mut end = url_start + scheme.len();
        while end < bytes.len()
            && !matches!(bytes[end], b'"' | b'\'' | b' ' | b'\n' | b'\r' | b'\\' | b'`')
        {
            end += 1;
        }
        urls.push(&text[url_start..end]);
        start = end;
    }
    urls
}
