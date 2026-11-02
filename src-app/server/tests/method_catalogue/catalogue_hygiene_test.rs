//! ITEM-6 — the catalogue-hygiene + regen-parity integration suite
//! (TEST-MC-8, TEST-MC-9, TEST-MC-18, TEST-MC-21's data half, TEST-MC-24,
//! TEST-MC-25). What each test pins:
//!
//! - TEST-MC-8: the generator's hermetic parity — `--check --fixtures` (and
//!   the generator's own `--selftest`) run against the COMMITTED fixture
//!   registry, byte-exact under the pinned `SOURCE_DATE_EPOCH`. The committed
//!   `data/method-catalogue/catalogue.json` is the REAL catalogue (ITEM-1);
//!   its parity is the real-mode `--check`, recorded in the module README's
//!   regen runbook (owner re-run; the benchmark tree is live-edited).
//! - TEST-MC-9: the runtime never reads the benchmark tree — a spawned server
//!   serves `GET /api/methods` 200 with `SIGTRANS_ROOT` absent; the loader is
//!   the compile-time `include_bytes!` embed (the unit half in `catalogue.rs`).
//! - TEST-MC-18: no `http(s)://` literal, no case-insensitive word-bounded
//!   `stud(y|ies)` token and no status/placeholder words (the generator's own
//!   token set, INV-5) anywhere in the shipped catalogue + module prose files.
//! - TEST-MC-24: the catalogue is method-level aggregates only — the schema
//!   REFUSES a per-patient or per-dataset field (typed `deny_unknown_fields`),
//!   and the committed file carries no patient-record keys, no per-dataset
//!   numbers and no content sourced from `restricted/`.
//! - TEST-MC-25: every `methods[]` entry carries the bool
//!   `embeds_training_data`, and `model-warnings.tsv` maps 1:1 into the
//!   entries (a row naming a REAL method matches its entry; methods absent
//!   from the TSV are false; fixture-only rows are inert for the real file).
//! - TEST-MC-21 (data half): the module ships no outbound-client path — no
//!   fetch/HTTP-client/socket import at all (the routes' only IO is the
//!   request/response; `check-network-allowlist.sh` stays green unmodified).

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

use crate::common::TestServer;

/// The repo root (the test binary runs with cwd = the crate dir under
/// `cargo test`; `CARGO_MANIFEST_DIR` is `src-app/server`).
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-app")
        .parent()
        .expect("repo root")
        .to_path_buf()
}

/// The generator's TOKEN definitions (copied verbatim from
/// `scripts/method-catalogue/gen_method_catalogue.py` — the single source of
/// the INV-5 acceptance; a divergence here is the finding, not the fix):
/// URLs, word-bounded case-insensitive `stud(y|ies)` (so `substudy` /
/// `STUDY19060127` are NOT tokens — the generator's sanitizer definition),
/// and status/placeholder words.
fn hygiene_tokens() -> Vec<&'static str> {
    vec![
        r"https?://\S+",
        r"(?i)\bstud(?:ies|y)\b",
        r"(?i)\bplaceholder\b",
        r"(?i)\bin\s+progress\b",
        r"(?i)\b(?:todo|fixme|wip)\b",
    ]
}

fn find_violations(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for token in hygiene_tokens() {
        let re = regex::Regex::new(token).expect("token regex");
        for m in re.find_iter(text) {
            let line = text[..m.start()].matches('\n').count() + 1;
            out.push(format!("{token:?} @ line {line}"));
        }
    }
    out
}

fn run_ok(cmd: &mut Command, what: &str) -> std::process::Output {
    let out = cmd.output().unwrap_or_else(|e| panic!("{what}: spawn failed: {e}"));
    if !out.status.success() {
        panic!(
            "{what}: exit {:?}\nstdout:\n{}\nstderr:\n{}",
            out.status.code(),
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
    }
    out
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST-MC-8 — generator `--check` parity (fixture registry, hermetic)
// ─────────────────────────────────────────────────────────────────────────────

/// TEST-MC-8: the committed fixture expectation re-derives byte-exactly:
/// `python3 scripts/method-catalogue/gen_method_catalogue.py --check --fixtures`
/// exits 0, and the generator's own `--selftest` (TEST-MC-15/16) exits 0.
/// `--check` writes NOTHING (parity only) — the tree stays clean.
#[test]
fn generator_fixture_parity_and_selftest_are_green() {
    let repo = repo_root();
    let script = repo.join("scripts/method-catalogue/gen_method_catalogue.py");

    run_ok(
        Command::new("python3")
            .arg(&script)
            .arg("--check")
            .arg("--fixtures")
            .current_dir(&repo),
        "generator --check --fixtures",
    );

    // The generator prints its own parity summary; re-run the selftest (the
    // TEST-MC-15/16 invariants are the generator's, the CI leg is here).
    let out = run_ok(
        Command::new("python3")
            .arg(&script)
            .arg("--selftest")
            .current_dir(&repo),
        "generator --selftest",
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        stdout.contains("self-test OK"),
        "selftest must report OK:\n{stdout}"
    );
    assert!(stdout.contains("PASS"), "selftest must report PASS lines:\n{stdout}");
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST-MC-9 — no benchmark tree at run time (HTTP half)
// ─────────────────────────────────────────────────────────────────────────────

/// TEST-MC-9: the spawned server (a subprocess with no `SIGTRANS_ROOT` — this
/// test's environment never sets the generator's build-time variable) answers
/// `GET /api/methods` 200 from the EMBEDDED bytes. The loader is
/// `include_bytes!` + an in-memory parse (`catalogue.rs`); nothing consults
/// the benchmark tree, which does not need to exist on the user's machine.
#[tokio::test]
async fn server_serves_methods_without_the_benchmark_tree() {
    let server = TestServer::spawn().await;

    // The local-owner mint (desktop's session) → bearer.
    let resp = server
        .client
        .post(server.api_url("/session/local"))
        .json(&serde_json::json!({}))
        .send()
        .await
        .expect("local session");
    assert_eq!(resp.status().as_u16(), 200, "local session mints the owner");
    let body: Value = resp.json().await.expect("session body");
    let token = body["access_token"]
        .as_str()
        .or_else(|| body["token"].as_str())
        .expect("session token")
        .to_string();

    let resp = server
        .client
        .get(server.api_url("/methods"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("GET /api/methods");
    assert_eq!(resp.status().as_u16(), 200, "served from the embedded catalogue");
    let body: Value = resp.json().await.expect("body");
    let methods = body["methods"].as_array().expect("methods array");
    assert!(!methods.is_empty(), "the runnable set is non-empty");
    assert_eq!(body["total"], methods.len() as u64);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST-MC-18 — catalogue + module prose hygiene (INV-5)
// ─────────────────────────────────────────────────────────────────────────────

/// TEST-MC-18: the committed catalogue and the module's prose files carry no
/// URL literal, no word-bounded `stud(y|ies)` token and no
/// status/placeholder words (the generator's own token set; the generator's
/// post-generation scanner enforces the same set, so a committed file that
/// fails here could never have been written).
#[test]
fn catalogue_and_module_prose_carry_no_banned_tokens() {
    let repo = repo_root();

    let catalogue_path = repo.join("data/method-catalogue/catalogue.json");
    let catalogue_text = std::fs::read_to_string(&catalogue_path)
        .expect("committed catalogue.json");
    let in_catalogue = find_violations(&catalogue_text);
    assert!(
        in_catalogue.is_empty(),
        "catalogue.json hygiene: {in_catalogue:?}"
    );

    // The runnable contract on the SHIPPED bytes: every runnable method
    // carries a non-empty env image/digest/contract (the boot validator
    // `catalogue.rs` enforces the same on LOAD — this leg pins the FILE, so a
    // rebuild that fast-forwards the generated file cannot ship a hole).
    let doc: Value = serde_json::from_str(&catalogue_text).expect("catalogue parses");
    for m in doc["methods"].as_array().expect("methods") {
        if m["runnable"].as_bool().expect("runnable bool") {
            let env = &m["env"];
            for field in ["image", "digest", "contract"] {
                let v = env[field].as_str().expect("env field string");
                assert!(
                    !v.is_empty(),
                    "runnable method {} has an empty env.{field}",
                    m["id"]
                );
            }
        }
    }

    // Module prose: the module's .rs files with `#[cfg(test)]` blocks removed
    // (test code is not shipped prose) + the README (created at ITEM-6).
    let module_dir = repo.join("src-app/server/src/modules/method_catalogue");
    let mut files: Vec<PathBuf> = std::fs::read_dir(&module_dir)
        .expect("module dir")
        .filter_map(|e| {
            let p = e.expect("entry").path();
            (p.extension().and_then(|x| x.to_str()) == Some("rs")).then_some(p)
        })
        .collect();
    files.push(module_dir.join("README.md"));
    files.sort();

    let mut violations = Vec::new();
    for f in files {
        let text = std::fs::read_to_string(&f).unwrap_or_else(|e| panic!("{}: {e}", f.display()));
        let text = if f.extension().and_then(|x| x.to_str()) == Some("rs") {
            strip_cfg_test(&text)
        } else {
            text
        };
        for v in find_violations(&text) {
            violations.push(format!("{}: {v}", f.display()));
        }
    }
    assert!(violations.is_empty(), "module prose hygiene:\n{}", violations.join("\n"));
}

/// Drop `#[cfg(test)] mod tests { ... }` blocks (the shipped prose scan
/// mirrors the allowlist's `clean()`: tests are not product source). The
/// block is tracked by BRACE DEPTH, not by the next column-0 `}` — test code
/// indents its items, but `}` can legitimately appear at column 0 inside a
/// multi-line string literal of a test.
fn strip_cfg_test(text: &str) -> String {
    let mut out = Vec::new();
    let mut in_tests = false;
    let mut depth: usize = 0;
    for line in text.lines() {
        if !in_tests && line.trim_start().starts_with("#[cfg(test)]") {
            in_tests = true;
            continue;
        }
        if in_tests {
            if line.trim_start().starts_with("mod tests {") || line.trim_start().starts_with("mod tests ")
            {
                depth = 1;
                continue;
            }
            if depth > 0 {
                depth += line.matches('{').count();
                depth = depth.saturating_sub(line.matches('}').count());
                if depth == 0 {
                    in_tests = false;
                }
                continue;
            }
            // A second cfg(test) on the same line cannot occur; drift into a
            // non-module cfg(test) body is swallowed conservatively.
            continue;
        }
        out.push(line);
    }
    out.join("\n")
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST-MC-24 — aggregates only (INV-6)
// ─────────────────────────────────────────────────────────────────────────────

/// TEST-MC-24 (schema half): the model REFUSES a per-patient or per-dataset
/// field — a catalogue entry carrying one fails the typed parse with the
/// named embed error (`deny_unknown_fields`; the boot posture, DEC-15).
#[test]
fn schema_refuses_per_patient_and_per_dataset_fields() {
    use cytoanalyst::modules::method_catalogue::catalogue::parse_catalogue;

    let base = r#"{{
        "schema_version": 1,
        "generated_from": {{"registry_name":"r","methods_commit":"m",
            "manifest_commit":"m","results_commit":"m","generated_at":"2026-01-01T00:00:00Z"}},
        "methods": [{method}],
        "markers": [],
        "groups": []
    }}"#;

    let method_entry = r#"{
        "id": "fx-p", "version": "1.0.0", "group": "response-call",
        "group_label": "Response call", "journal": "J", "year": 2026,
        "citations": 0, "language": "R", "paper_doi": "", "spec_status": "draft",
        "frozen_model": false, "container": false, "runnable": true,
        "gate": {"pass": true, "report_name": "p.report.md"},
        "env": {"image": "ghcr.io/tinnlab/txresbench-fx-p:1.0.0",
                "digest": "sha256:aa", "contract": "2.0"},
        "markers": {"kind": "any", "count": 0}, "covariates": "none",
        "min_draws": 1, "needs_baseline": false, "uses_history": "landmark",
        "fitted": false, "saves_model": false, "own_outputs": [], "tasks": [],
        "required_markers": null, "needs_detection_call": false,
        "marker_groups_required": [], "description": "d",
        "timing": {"base_seconds_per_fold": 1.0, "benchmarked_units": 0, "quality": "estimate"},
        "performance": null, "embeds_training_data": false,
        "software": {"language": "R 4.4.2", "packages": {}},
        "licence": "MIT", "references": [], "params": {}
    }"#;

    for (field, value) in [
        ("per_patient", r#"[{"patient_key":"p0","baseline_draws":1,"ontreatment_draws":1}]"#),
        ("per_dataset", r#"[{"dataset_id":"FX001","c_index":0.7}]"#),
        ("datasets", r#"[{"id":"FX001","c_index":0.7}]"#),
    ] {
        let mut entry = method_entry.trim_end_matches('}').to_string();
        entry.push_str(&format!(",\n        {field}: {value}\n    }}"));
        let doc = base.replace("{method}", &entry);
        let err = parse_catalogue(doc.as_bytes())
            .expect_err(&format!("the {field} field must be refused"));
        assert_eq!(
            err.code(),
            "CATALOGUE_EMBED_INVALID",
            "the {field} field must be a named parse refusal"
        );
    }
}

/// TEST-MC-24 (data half): the committed file holds no patient records, no
/// per-dataset content and nothing sourced from `restricted/` — the only
/// per-unit facts are the method-level aggregate counts (n_units, n_datasets,
/// benchmarked_units, n_methods).
#[test]
fn committed_catalogue_holds_no_patient_or_dataset_records() {
    let repo = repo_root();
    let text = std::fs::read_to_string(repo.join("data/method-catalogue/catalogue.json"))
        .expect("committed catalogue.json");
    let doc: Value = serde_json::from_str(&text).expect("catalogue parses as JSON");

    // The schema's structural proof: the typed parse succeeded at boot (the
    // unit suite), so any unknown KEY below is a category we did not model.
    // Walk the JSON tree: banned exact keys (a patient record / a per-dataset
    // table / a restricted-source marker), never a substring — wrapper params
    // legitimately carry names like `min_patients_class` or `dataset`.
    let banned_keys = [
        "per_patient", "patient_key", "patient_id", "subject_id", "subject_key",
        "sample_id", "per_dataset", "dataset_id", "per_unit", "records", "rows",
        "restricted", "restricted_path",
    ];
    let mut offender: Option<(String, String)> = None;
    fn walk(v: &Value, path: &str, banned: &[&str], offender: &mut Option<(String, String)>) {
        match v {
            Value::Object(map) => {
                for (k, child) in map {
                    if banned.contains(&k.as_str()) && offender.is_none() {
                        *offender = Some((k.clone(), format!("{path}/{k}")));
                    }
                    walk(child, &format!("{path}/{k}"), banned, offender);
                }
            }
            Value::Array(items) => {
                for (i, child) in items.iter().enumerate() {
                    walk(child, &format!("{path}[{i}]"), banned, offender);
                }
            }
            _ => {}
        }
    }
    walk(&doc, "", &banned_keys, &mut offender);
    assert!(
        offender.is_none(),
        "patient/dataset-record key {:?} at {}",
        offender.clone().unwrap_or_default().0,
        offender.clone().unwrap_or_default().1
    );

    // Nothing sourced from the restricted raw-data dir or the teammate tree.
    for needle in ["restricted/raw", "/restricted/", "/data/share/khoi", "restricted/"] {
        assert!(
            !text.contains(needle),
            "restricted-source content must not be in the catalogue: {needle}"
        );
    }

    // The catalogue's ONLY dataset-shaped numbers are aggregates: every
    // `performance` block is median + counts, every `timing` block is a median
    // + a count + a quality name.
    let methods = doc["methods"].as_array().expect("methods");
    assert!(!methods.is_empty());
    for m in methods {
        if let Some(perf) = m.get("performance") {
            if !perf.is_null() {
                let keys: Vec<&str> =
                    perf.as_object().expect("performance object").keys().map(|s| s.as_str()).collect();
                assert!(
                    keys.iter().all(|k| ["c_index_median", "auc_rule_median", "n_units", "n_datasets"]
                        .contains(k)),
                    "performance must be aggregates only: {keys:?}"
                );
            }
        }
        let timing = m["timing"].as_object().expect("timing");
        let tkeys: Vec<&str> = timing.keys().map(|s| s.as_str()).collect();
        assert!(
            tkeys.iter().all(|k| ["base_seconds_per_fold", "benchmarked_units", "quality"]
                .contains(k)),
            "timing must be median + count + quality: {tkeys:?}"
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST-MC-25 — embeds_training_data + model-warnings.tsv parity
// ─────────────────────────────────────────────────────────────────────────────

/// TEST-MC-25: every `methods[]` entry carries a BOOL `embeds_training_data`;
/// the curated `model-warnings.tsv` maps into the entries (a row naming a
/// REAL method matches that entry; methods absent from the TSV are false).
#[test]
fn every_entry_carries_embeds_training_data_and_tsv_parity() {
    let repo = repo_root();
    let text = std::fs::read_to_string(repo.join("data/method-catalogue/catalogue.json"))
        .expect("catalogue");
    let doc: Value = serde_json::from_str(&text).expect("catalogue");

    // The TSV rows: id -> bool (comment + header lines skipped).
    let tsv = std::fs::read_to_string(repo.join("scripts/method-catalogue/model-warnings.tsv"))
        .expect("model-warnings.tsv");
    let mut warned: std::collections::BTreeMap<String, bool> = Default::default();
    for line in tsv.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut it = line.split('\t');
        let id = it.next().expect("id column");
        let v = it.next().expect("bool column");
        if id == "method_id" {
            continue;
        }
        let parsed: bool = v.parse().expect("tsv bool");
        warned.insert(id.to_string(), parsed);
    }

    let methods = doc["methods"].as_array().expect("methods");
    assert!(!methods.is_empty());
    for m in methods {
        let id = m["id"].as_str().expect("method id");
        let present = m.get("embeds_training_data").expect("embeds_training_data");
        assert!(
            present.is_boolean(),
            "{id}: embeds_training_data must be a bool"
        );
        let expected = *warned.get(id).unwrap_or(&false);
        assert_eq!(
            present.as_bool().expect("bool"),
            expected,
            "{id}: model-warnings.tsv parity (absent rows default false)"
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST-MC-21 (data half) — no outbound-client path in the module
// ─────────────────────────────────────────────────────────────────────────────

/// TEST-MC-21 (data half): the module has NO outbound-client path — no HTTP
/// client or socket import in the shipped module sources (the routes' only IO
/// is the request/response; the allowlist guard runs green and unmodified).
#[test]
fn module_ships_no_outbound_client_path() {
    let repo = repo_root();
    let module_dir = repo.join("src-app/server/src/modules/method_catalogue");
    let banned = [
        "reqwest",
        "ureq",
        "hyper_util::client",
        "hyper::client",
        "TcpStream",
        "UdpSocket",
        "tokio::net",
        "socket2",
        "awc",
        "isahc",
        "curl",
    ];
    let mut found = Vec::new();
    for f in std::fs::read_dir(&module_dir).expect("module dir") {
        let p = f.expect("entry").path();
        if p.extension().and_then(|x| x.to_str()) != Some("rs") {
            continue;
        }
        let text = std::fs::read_to_string(&p).expect("module file");
        let text = strip_cfg_test(&text);
        for needle in banned {
            if text.contains(needle) {
                found.push(format!("{}: {needle}", p.display()));
            }
        }
    }
    assert!(
        found.is_empty(),
        "the module must ship no client/socket path:\n{}",
        found.join("\n")
    );
}
