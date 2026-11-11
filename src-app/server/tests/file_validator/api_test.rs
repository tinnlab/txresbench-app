//! The `file_validator` HTTP routes suite — TEST-FV-7/8/9/20/21/22/23/25,
//! over the REAL embedded assets (the shipped synthetic example) and the
//! board-scenario fixture tables (EXAMPLE-FV-1/2).
//!
//! Each test spawns one server through the shared harness (`TestServer`); the
//! local-owner mint (`POST /api/session/local`) is the desktop bearer, exactly
//! as on the other module suites. The engine halves of the same facts live in
//! the in-module tests (`inspect.rs` / `validate.rs`); this suite proves the
//! TRANSPORT: the four endpoints, their error codes, the by-row problem
//! placement and the byte-for-byte asset serving.
//!
//! ## Why "the same call in a second mode" is a repeat-call determinism pin
//!
//! TEST-FV-7's second mode (predict) has no patients side by design — a
//! measurements-only call carries no R08/R15 facts (the ITEM-5 note: the
//! determinism claim is asserted as byte-equality on repeat calls, plus the
//! shared per-file codes across inspect and predict validate).

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

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

/// The fixed-owner mint (the desktop's local session) → bearer token.
async fn owner_token(server: &TestServer) -> String {
    let resp = server
        .client
        .post(server.api_url("/session/local"))
        .json(&json!({}))
        .send()
        .await
        .expect("local session");
    assert_eq!(resp.status().as_u16(), 200, "local session mints the owner");
    let body: Value = resp.json().await.expect("session body");
    body["access_token"]
        .as_str()
        .or_else(|| body["token"].as_str())
        .expect("session carries a token")
        .to_string()
}

/// The error_code of a framework error body
/// (`{error: <message>, error_code: <code>}` — AppError's wire shape).
fn error_code(body: &Value) -> String {
    body["error_code"]
        .as_str()
        .or_else(|| body["error"]["error_code"].as_str())
        .unwrap_or_else(|| panic!("no error_code in body: {body}"))
        .to_string()
}

/// One wire `ParsedTable` from string rows (data rows only; header at file
/// row 1 — DEC-6).
fn table(name: &str, columns: &[&str], rows: &[Vec<&str>]) -> Value {
    let rows: Vec<Vec<String>> = rows
        .iter()
        .map(|r| r.iter().map(|c| c.to_string()).collect())
        .collect();
    table_strings(name, columns, rows)
}

/// One wire `ParsedTable` from owned string rows.
fn table_strings(name: &str, columns: &[&str], rows: Vec<Vec<String>>) -> Value {
    let rows: Vec<Vec<Value>> = rows
        .iter()
        .map(|r| r.iter().cloned().map(Value::String).collect())
        .collect();
    json!({
        "source": {"name": name, "format": "csv"},
        "header_row": 1,
        "columns": columns,
        "rows": rows,
    })
}

/// The board-C fixture of EXAMPLE-FV-1 (the ITEM-5 engine-half fixture as a
/// wire body): 12 patients; 84 regular measurement rows (7 per patient);
/// data index 12 = FILE row 14 (day "week 4"); four `P0187` rows at data
/// indexes 86..89 = FILE rows 88..91 (not in the patients file).
fn board_patients() -> Value {
    let rows: Vec<Vec<String>> = (0..12)
        .map(|i| {
            vec![
                format!("P{i:04}"),
                "100".to_string(),
                "1".to_string(),
                "120".to_string(),
                "0".to_string(),
            ]
        })
        .collect();
    table_strings(
        "patients.csv",
        &["patient_id", "pfs_days", "pfs_event", "os_days", "os_event"],
        rows,
    )
}

/// The board measurements table (ldh/LDH + M1 per patient, the "week 4" row,
/// the extra M1 row, the four P0187 rows).
fn board_measurements() -> Value {
    let mut measurements: Vec<Vec<String>> = Vec::new();
    for i in 0..12usize {
        for (day, marker) in [
            ("0", "ldh"),
            ("7", "LDH"),
            ("0", "M1"),
            ("14", "M1"),
            ("28", "M1"),
            ("42", "M1"),
            ("56", "M1"),
        ] {
            measurements.push(vec![
                format!("P{i:04}"),
                day.to_string(),
                marker.to_string(),
                "100".to_string(),
                "U/L".to_string(),
            ]);
        }
    }
    // Data index 12 = file row 14: the board's "week 4" day.
    measurements.insert(
        12,
        vec![
            "P0009".to_string(),
            "week 4".to_string(),
            "ldh".to_string(),
            "100".to_string(),
            "U/L".to_string(),
        ],
    );
    // Fill to data index 85 (file row 87) so the four P0187 rows land at file
    // rows 88..91 (the board's "Rows 88 to 91").
    measurements.push(vec![
        "P0011".to_string(),
        "70".to_string(),
        "M1".to_string(),
        "100".to_string(),
        "U/L".to_string(),
    ]);
    assert_eq!(measurements.len(), 86);
    for _ in 0..4 {
        measurements.push(vec![
            "P0187".to_string(),
            "0".to_string(),
            "ldh".to_string(),
            "100".to_string(),
            "U/L".to_string(),
        ]);
    }
    table_strings(
        "measurements.csv",
        &["patient_id", "day", "marker", "value", "unit"],
        measurements,
    )
}

fn problems_of<'a>(body: &'a Value, code: &str) -> Vec<&'a Value> {
    body["problems"]
        .as_array()
        .expect("problems array")
        .iter()
        .filter(|p| p["code"] == code)
        .collect()
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST-FV-7 — the board C scenario (EXAMPLE-FV-1)
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn board_c_scenario_returns_the_planned_problems() {
    let server = TestServer::spawn().await;
    let token = owner_token(&server).await;

    let body = json!({
        "mode": "files",
        "patients": board_patients(),
        "measurements": board_measurements(),
        "joins": [],
        "mapping": [],
        "parameters": {"decision_day": 56.0, "baseline_max_day": 0.0},
    });
    let resp = server
        .client
        .post(server.api_url("/file-validation/validate"))
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .expect("validate");
    assert_eq!(resp.status().as_u16(), 200, "the board C fixture validates");
    let response_body: Value = resp.json().await.expect("body");

    // Row 14: day "week 4" → R03 error on the day column, naming the cell.
    let r03 = problems_of(&response_body, "R03");
    let at_14: Vec<_> = r03.iter().filter(|p| p["row"] == json!(14)).collect();
    assert_eq!(at_14.len(), 1, "R03s: {r03:?}");
    assert_eq!(at_14[0]["column"], json!("day"));
    assert!(
        at_14[0]["message"].as_str().unwrap().contains("week 4"),
        "{}",
        at_14[0]["message"]
    );

    // Rows 88..91: P0187 is not in the patients file → four R08 (one per row)
    // plus the R15 the ITEM-3 convention adds (one per derived sample).
    let r08 = problems_of(&response_body, "R08");
    assert_eq!(r08.len(), 4, "four measurement rows of P0187: {r08:?}");
    for (i, p) in r08.iter().enumerate() {
        assert_eq!(p["row"], json!(88 + i), "R08 row placement");
    }
    let r15 = problems_of(&response_body, "R15");
    assert_eq!(r15.len(), 1, "one derived P0187 sample: {r15:?}");
    assert_eq!(r15[0]["row"], json!(88));

    // The ldh/LDH join offer: one A03 naming both spellings; the column
    // carries both spellings and is NOT auto-joined (DEC-12).
    let a03 = problems_of(&response_body, "A03");
    assert_eq!(a03.len(), 1, "the join offer: {a03:?}");
    let msg = a03[0]["message"].as_str().expect("message");
    assert!(msg.contains("ldh") && msg.contains("LDH"), "{msg}");
    let ldh = response_body["markers"]
        .as_array()
        .expect("markers")
        .iter()
        .find(|m| m["key"] == "ldh")
        .expect("the ldh column");
    assert_eq!(ldh["spellings"], json!(["ldh", "LDH"]));

    // Determinism: a repeat call (the SAME request) is byte-equal (no state,
    // no timestamps). The request value stays the request: the response is
    // parsed under a separate name.
    let request = body;
    let again = server
        .client
        .post(server.api_url("/file-validation/validate"))
        .bearer_auth(&token)
        .json(&request)
        .send()
        .await
        .expect("validate again");
    let again: Value = again.json().await.expect("body");
    assert_eq!(again.to_string(), response_body.to_string(), "repeat call byte-equal");
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST-FV-8 — the unit verdicts (EXAMPLE-FV-2; the vocabulary reference is
// the user's mapping — TESTS.md ITEM-5 note, DRIFT-1 ITEM-5 #1)
// ─────────────────────────────────────────────────────────────────────────────

/// The predict-mode unit fixture: one LDH column with the given units (or no
/// unit column) for one patient.
fn ldh_request(units: Option<&[&str]>) -> Value {
    let columns: Vec<&str> = match units {
        Some(_) => vec!["patient_id", "day", "marker", "value", "unit"],
        None => vec!["patient_id", "day", "marker", "value"],
    };
    let rows: Vec<Vec<String>> = match units {
        Some(units) => units
            .iter()
            .enumerate()
            .map(|(i, u)| {
                vec![
                    "P1".to_string(),
                    (i as u64 * 14).to_string(),
                    "LDH".to_string(),
                    "100".to_string(),
                    u.to_string(),
                ]
            })
            .collect(),
        None => vec![
            vec!["P1".to_string(), "0".to_string(), "LDH".to_string(), "100".to_string()],
            vec!["P1".to_string(), "14".to_string(), "LDH".to_string(), "110".to_string()],
        ],
    };
    let measurements = table_strings("measurements.csv", &columns, rows);
    json!({
        "mode": "predict",
        "patients": null,
        "measurements": measurements,
        "joins": [],
        "mapping": [{"key": "LDH", "marker_id": "14804-9"}],
        "parameters": {"decision_day": 56.0, "baseline_max_day": 0.0},
    })
}

#[tokio::test]
async fn unit_verdicts_follow_the_mapping_reference() {
    let server = TestServer::spawn().await;
    let token = owner_token(&server).await;

    // U/L = the vocabulary's canonical unit → matches + SILENT.
    let resp = server
        .client
        .post(server.api_url("/file-validation/validate"))
        .bearer_auth(&token)
        .json(&ldh_request(Some(&["U/L", "U/L"])))
        .send()
        .await
        .expect("validate");
    assert_eq!(resp.status().as_u16(), 200);
    let body: Value = resp.json().await.expect("body");
    let column = &body["markers"][0];
    assert_eq!(column["unit_status"], json!("matches"));
    assert_eq!(column["key"], json!("LDH"));
    assert!(
        problems_of(&body, "A04").is_empty() && problems_of(&body, "A07").is_empty(),
        "a matching unit is silent: {}",
        body["problems"]
    );
    // The inventory family is the vocabulary's authoritative one (DEC-10: the
    // shipped LDH entry declares family none).
    let inv = &body["inventory"]["markers"][0];
    assert_eq!(inv["unit_family"], json!("none"));
    assert_eq!(inv["standard_ids"][0]["id"], json!("14804-9"));
    assert_eq!(inv["display_name"], json!("LDH"));

    // U/mL → the family agrees, the unit does not → family + A04 WARNING.
    let resp = server
        .client
        .post(server.api_url("/file-validation/validate"))
        .bearer_auth(&token)
        .json(&ldh_request(Some(&["U/mL", "U/mL"])))
        .send()
        .await
        .expect("validate");
    let body: Value = resp.json().await.expect("body");
    assert_eq!(body["markers"][0]["unit_status"], json!("family"));
    let a04 = problems_of(&body, "A04");
    assert_eq!(a04.len(), 1, "the family-only unit is a warning: {:?}", body["problems"]);
    assert_eq!(a04[0]["severity"], json!("warning"));

    // No unit column → absent + A07 (never a silent scale assumption).
    let resp = server
        .client
        .post(server.api_url("/file-validation/validate"))
        .bearer_auth(&token)
        .json(&ldh_request(None))
        .send()
        .await
        .expect("validate");
    let body: Value = resp.json().await.expect("body");
    assert_eq!(body["markers"][0]["unit_status"], json!("absent"));
    let a07 = problems_of(&body, "A07");
    assert_eq!(a07.len(), 1, "the absent unit is reported: {:?}", body["problems"]);

    // Mixed within one marker → mixed + A04 ERROR naming the rows.
    let resp = server
        .client
        .post(server.api_url("/file-validation/validate"))
        .bearer_auth(&token)
        .json(&ldh_request(Some(&["U/L", "U/mL"])))
        .send()
        .await
        .expect("validate");
    let body: Value = resp.json().await.expect("body");
    assert_eq!(body["markers"][0]["unit_status"], json!("mixed"));
    let a04 = problems_of(&body, "A04");
    assert_eq!(a04.len(), 1, "the mixed unit is one error: {:?}", body["problems"]);
    assert_eq!(a04[0]["severity"], json!("error"));
    let msg = a04[0]["message"].as_str().expect("message");
    assert!(msg.contains("2"), "{msg}");
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST-FV-9 — screen N (predict mode) shares the endpoints; MISSING_PATIENTS
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn predict_mode_serves_the_measurements_only_flow() {
    let server = TestServer::spawn().await;
    let token = owner_token(&server).await;

    let measurements = table(
        "measurements.csv",
        &["patient_id", "day", "marker", "value", "unit"],
        &[
            vec!["P1", "0", "M1", "42", "a.u."],
            vec!["P1", "7", "M1", "43", "a.u."],
            vec!["P2", "0", "M1", "40", "a.u."],
        ],
    );
    let body = json!({
        "mode": "predict",
        "measurements": measurements.clone(),
        "joins": [],
        "mapping": [],
        "parameters": {"decision_day": 56.0, "baseline_max_day": 0.0},
    });
    let resp = server
        .client
        .post(server.api_url("/file-validation/validate"))
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .expect("predict validate");
    assert_eq!(resp.status().as_u16(), 200, "screen N answers 200");
    let response_body: Value = resp.json().await.expect("body");
    assert!(
        response_body["patients"].is_null(),
        "no patients side in predict mode"
    );
    assert_eq!(response_body["measurements"]["patients"], json!(2));
    assert_eq!(response_body["inventory"]["patients"], json!(2));
    assert!(
        response_body["problems"]
            .as_array()
            .expect("problems")
            .iter()
            .all(|p| p["severity"] != "error"),
        "the valid fixture has no errors: {}",
        response_body["problems"]
    );

    // The same measurements table in files mode without a patients table is
    // the loud MISSING_PATIENTS 400.
    let mut files = body;
    files["mode"] = json!("files");
    let resp = server
        .client
        .post(server.api_url("/file-validation/validate"))
        .bearer_auth(&token)
        .json(&files)
        .send()
        .await
        .expect("files validate");
    assert_eq!(resp.status().as_u16(), 400);
    let err: Value = resp.json().await.expect("error body");
    assert_eq!(error_code(&err), "MISSING_PATIENTS");
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST-FV-20 / TEST-FV-23 — the asset endpoints (embedded bytes; 404; 401)
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn template_and_example_endpoints_serve_the_committed_bytes() {
    let server = TestServer::spawn().await;
    let token = owner_token(&server).await;

    for (path, repo_rel) in [
        ("/file-validation/templates/patients", "data/file-validator/templates/patients.csv"),
        (
            "/file-validation/templates/measurements",
            "data/file-validator/templates/measurements.csv",
        ),
        ("/file-validation/examples/patients", "data/file-validator/examples/patients.csv"),
        (
            "/file-validation/examples/measurements",
            "data/file-validator/examples/measurements.csv",
        ),
        (
            "/file-validation/examples/predict-measurements",
            "data/file-validator/examples/predict-measurements.csv",
        ),
    ] {
        let resp = server
            .client
            .get(server.api_url(path))
            .bearer_auth(&token)
            .send()
            .await
            .expect(path);
        let status = resp.status().as_u16();
        if status != 200 {
            panic!("{path}: {status} body={}", resp.text().await.unwrap_or_default());
        }
        let ct = resp
            .headers()
            .get("content-type")
            .expect("content type")
            .to_str()
            .expect("utf8")
            .to_string();
        assert_eq!(ct, "text/csv; charset=utf-8", "{path}");
        let bytes = resp.bytes().await.expect(path);
        let committed =
            std::fs::read(repo_root().join(repo_rel)).expect("committed file");
        assert_eq!(
            bytes.as_ref(),
            committed.as_slice(),
            "{path} serves the committed bytes verbatim"
        );
    }

    // The template headers are the board's column specs (PROV-FV-4).
    let resp = server
        .client
        .get(server.api_url("/file-validation/templates/patients"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("patients template");
    let text = resp.text().await.expect("text");
    assert_eq!(
        text.trim(),
        "patient_id,pfs_days,pfs_event,os_days,os_event,responder,response_day,age,sex,stage"
    );
    let resp = server
        .client
        .get(server.api_url("/file-validation/templates/measurements"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("measurements template");
    let text = resp.text().await.expect("text");
    assert_eq!(text.trim(), "patient_id,day,marker,value,unit");

    // An unknown kind is the planned 404 with the named code (both endpoints).
    for path in [
        "/file-validation/templates/tables",
        "/file-validation/examples/tables",
    ] {
        let resp = server
            .client
            .get(server.api_url(path))
            .bearer_auth(&token)
            .send()
            .await
            .expect(path);
        assert_eq!(resp.status().as_u16(), 404, "{path}");
        let err: Value = resp.json().await.expect("error body");
        assert_eq!(error_code(&err), "INVALID_EXAMPLE_KIND", "{path}");
    }

    // Unauthenticated → 401 (the gated-route proof).
    let resp = server
        .client
        .get(server.api_url("/file-validation/templates/patients"))
        .send()
        .await
        .expect("unauth template");
    assert_eq!(resp.status().as_u16(), 401);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST-FV-21 — validation errors + auth
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn request_errors_are_the_named_400s_and_auth_is_enforced() {
    let server = TestServer::spawn().await;
    let token = owner_token(&server).await;

    // 401 without the bearer (inspect + validate).
    for (method, path) in [
        (reqwest::Method::POST, "/file-validation/inspect"),
        (reqwest::Method::POST, "/file-validation/validate"),
    ] {
        let resp = server
            .client
            .request(method, server.api_url(path))
            .json(&json!({}))
            .send()
            .await
            .expect(path);
        assert_eq!(resp.status().as_u16(), 401, "{path} without a token");
    }

    // UNKNOWN kind → 400 INVALID_KIND (never the framework's 422).
    let resp = server
        .client
        .post(server.api_url("/file-validation/inspect"))
        .bearer_auth(&token)
        .json(&json!({"kind": "tables", "table": {
            "source": {"name": "x.csv", "format": "csv"},
            "header_row": 1, "columns": [], "rows": [],
        }}))
        .send()
        .await
        .expect("bad kind");
    assert_eq!(resp.status().as_u16(), 400);
    let err: Value = resp.json().await.expect("error body");
    assert_eq!(error_code(&err), "INVALID_KIND");

    // UNKNOWN mode → 400 INVALID_MODE.
    let resp = server
        .client
        .post(server.api_url("/file-validation/validate"))
        .bearer_auth(&token)
        .json(&json!({"mode": "batch", "measurements": {}}))
        .send()
        .await
        .expect("bad mode");
    assert_eq!(resp.status().as_u16(), 400);
    let err: Value = resp.json().await.expect("error body");
    assert_eq!(error_code(&err), "INVALID_MODE");

    // A non-finite decision_day cannot even be a JSON number — serde_json
    // refuses an out-of-range float (`1e999` is syntactically valid JSON but
    // not representable) — so the raw body reaches the typed extractor, which
    // answers the named 400 (INVALID_MODE). The handler-level INVALID_PARAMETERS
    // backstop for the in-process seam is pinned by the routes.rs unit test.
    let resp = server
        .client
        .post(server.api_url("/file-validation/validate"))
        .bearer_auth(&token)
        .header("content-type", "application/json")
        .body(
            r#"{"mode": "predict", "measurements": {
                "source": {"name": "m.csv", "format": "csv"},
                "header_row": 1, "columns": ["patient_id", "day", "marker", "value"], "rows": []
            }, "parameters": {"decision_day": 1e999, "baseline_max_day": 0.0}}"#,
        )
        .send()
        .await
        .expect("non-finite day");
    assert_eq!(resp.status().as_u16(), 400, "a non-finite day is refused");
    let err: Value = resp.json().await.expect("error body");
    assert_eq!(error_code(&err), "INVALID_MODE", "{err}");

    // An INVALID_JOIN mapping (a key that is not a measurement marker key).
    let resp = server
        .client
        .post(server.api_url("/file-validation/validate"))
        .bearer_auth(&token)
        .json(&json!({
            "mode": "predict",
            "measurements": table("m.csv", &["patient_id", "day", "marker", "value"], &[
                vec!["P1", "0", "LDH", "100"],
            ]),
            "mapping": [{"key": "cea", "marker_id": "14804-9"}],
        }))
        .send()
        .await
        .expect("invalid join");
    assert_eq!(resp.status().as_u16(), 400);
    let err: Value = resp.json().await.expect("error body");
    assert_eq!(error_code(&err), "INVALID_JOIN");

    // MISSING_PATIENTS: files mode without a patients table.
    let resp = server
        .client
        .post(server.api_url("/file-validation/validate"))
        .bearer_auth(&token)
        .json(&json!({
            "mode": "files",
            "patients": null,
            "measurements": table("m.csv", &["patient_id", "day", "marker", "value"], &[
                vec!["P1", "0", "LDH", "100"],
            ]),
        }))
        .send()
        .await
        .expect("missing patients");
    assert_eq!(resp.status().as_u16(), 400);
    let err: Value = resp.json().await.expect("error body");
    assert_eq!(error_code(&err), "MISSING_PATIENTS");

    // A syntactically invalid JSON body is the named 400 (not the framework's
    // default rejection shape).
    let resp = server
        .client
        .post(server.api_url("/file-validation/validate"))
        .bearer_auth(&token)
        .header("content-type", "application/json")
        .body("{not json")
        .send()
        .await
        .expect("syntax error");
    assert_eq!(resp.status().as_u16(), 400);
    let err: Value = resp.json().await.expect("error body");
    assert_eq!(error_code(&err), "INVALID_MODE");
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST-FV-22 — ONE endpoint set serves both screens (INV-3)
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn one_endpoint_set_serves_c_and_n() {
    let server = TestServer::spawn().await;
    let token = owner_token(&server).await;

    // The same inspect endpoint answers a patients table, a files-mode
    // measurements table and a predict-mode measurements table — with the
    // kind in the response and byte-equal per-file results for the same
    // bytes.
    let patients = board_patients();
    let measurements = board_measurements();

    let resp = server
        .client
        .post(server.api_url("/file-validation/inspect"))
        .bearer_auth(&token)
        .json(&json!({"kind": "patients", "table": patients}))
        .send()
        .await
        .expect("inspect patients");
    assert_eq!(resp.status().as_u16(), 200);
    let inspected_patients: Value = resp.json().await.expect("body");
    assert_eq!(inspected_patients["kind"], json!("patients"));

    let inspect_measurements = |mode_token: &str| {
        server
            .client
            .post(server.api_url("/file-validation/inspect"))
            .bearer_auth(mode_token)
            .json(&json!({"kind": "measurements", "table": measurements.clone()}))
            .send()
    };
    let first = inspect_measurements(&token).await.expect("inspect measurements");
    assert_eq!(first.status().as_u16(), 200);
    let first: Value = first.json().await.expect("body");
    assert_eq!(first["kind"], json!("measurements"));
    let second = inspect_measurements(&token).await.expect("inspect measurements again");
    let second: Value = second.json().await.expect("body");
    assert_eq!(first.to_string(), second.to_string(), "inspect is byte-equal");

    // Validate differs ONLY by mode — the same measurements table is valid in
    // predict mode (patients: null) and needs its patients side in files mode.
    let validate_body = json!({
        "mode": "predict",
        "measurements": measurements.clone(),
        "joins": [],
        "mapping": [],
        "parameters": {"decision_day": 56.0, "baseline_max_day": 0.0},
    });
    let resp = server
        .client
        .post(server.api_url("/file-validation/validate"))
        .bearer_auth(&token)
        .json(&validate_body)
        .send()
        .await
        .expect("predict validate");
    let predict: Value = resp.json().await.expect("body");
    assert!(predict["patients"].is_null());

    // No mode-specific route exists: the module's handler surface is the four
    // inventory routes (routes.rs unit test pins the inventory); here the
    // source check makes the same fact a shipped-source property — the
    // inspect endpoint is the one both screens call (INV-3).
    let routes_src = std::fs::read_to_string(
        repo_root().join("src-app/server/src/modules/file_validator/routes.rs"),
    )
    .expect("routes.rs");
    for line in routes_src.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("async fn ") {
            assert!(
                !trimmed.contains("predict"),
                "a mode-scoped handler exists: {trimmed}"
            );
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST-FV-23 — the benchmark tree is not read at run time (INV-1) and
// TEST-FV-25 — zero runtime network (INV-5, source half)
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn the_server_serves_everything_from_embedded_bytes() {
    let server = TestServer::spawn().await;
    let token = owner_token(&server).await;

    // The four endpoints answer (the asset test above pins the byte equality
    // against the committed files — the assertion IS the no-tree proof: the
    // files are served from the boot-validated embed).
    let resp = server
        .client
        .post(server.api_url("/file-validation/inspect"))
        .bearer_auth(&token)
        .json(&json!({
            "kind": "measurements",
            "table": table("m.csv", &["patient_id", "day", "marker", "value"], &[]),
        }))
        .send()
        .await
        .expect("inspect");
    assert_eq!(resp.status().as_u16(), 200);
    let resp = server
        .client
        .post(server.api_url("/file-validation/validate"))
        .bearer_auth(&token)
        .json(&json!({
            "mode": "predict",
            "measurements": table("m.csv", &["patient_id", "day", "marker", "value"], &[]),
        }))
        .send()
        .await
        .expect("validate");
    assert_eq!(resp.status().as_u16(), 200);
    for path in [
        "/file-validation/templates/patients",
        "/file-validation/examples/measurements",
    ] {
        let resp = server
            .client
            .get(server.api_url(path))
            .bearer_auth(&token)
            .send()
            .await
            .expect(path);
        assert_eq!(resp.status().as_u16(), 200, "{path}");
    }

    // The module's shipped sources never mention the build-tree variable and
    // carry no network client/literal (INV-1/INV-5, source half — the
    // guard-script half is material_test.rs).
    let module_dir = repo_root().join("src-app/server/src/modules/file_validator");
    for entry in std::fs::read_dir(&module_dir).expect("module dir") {
        let path = entry.expect("entry").path();
        if path.extension().and_then(|e| e.to_str()) != Some("rs") {
            continue;
        }
        let text = std::fs::read_to_string(&path).expect("module source");
        assert!(
            !text.contains("SIGTRANS_ROOT"),
            "{} mentions the build-tree variable",
            path.display()
        );
        for banned in ["reqwest", "ureq", "hyper::Client", "http://", "https://"] {
            assert!(
                !text.contains(banned),
                "{} carries a network surface ({banned})",
                path.display()
            );
        }
    }
}
