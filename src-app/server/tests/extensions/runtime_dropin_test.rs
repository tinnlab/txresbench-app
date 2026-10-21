//! TEST-11 [ITEM-7/9/10] [acceptance] [invariant: INV-3, INV-7] — the RUNTIME
//! DROP-IN acceptance. The defining proof of D2: with the seed already extracted, a
//! FRESH fixture package (a new datatype id + `ui/*.yaml` + `compute/*.py`, NONE in
//! the seed) is written into `<data_root>/processors/` AT RUNTIME and a rescan is
//! triggered — and it is DISCOVERED with ZERO binary rebuild and ZERO app-file edit:
//!
//!   (a) its datatype lattice edge / title / viewer is registered (`GET /api/datatypes`);
//!   (b) its package + converter are listed `ok:true` (`GET /api/processors` + the reload
//!       response + `GET /api/extensions`);
//!   (c) its compute travels WITH the package — the converter's `run.entry` resolves to
//!       the co-located `compute/*.py` file on disk (the bytes are read from the folder,
//!       INV-7; the real bwrap EXEC of those bytes is proven by the S5 unit tier
//!       `sandbox::processors::resolve_reads_bytes_from_the_folder_and_reflects_edits`
//!       + the rootfs-gated dataset capsule suite);
//!   (d) a STATIC assertion that NO app/builtin source file names the fixture datatype
//!       id — the package is domain knowledge the binary knows nothing about (INV-3).
//!
//! Drives the REAL spawned server (its own boot extract + the shared
//! `reflect_processors` rescan behind `POST /api/processors/reload`), process-isolated
//! so the global arc-swap registry republish is safe.

use serde_json::Value;

use super::{setup_admin, write_dropin_fixture};
use crate::common::TestServer;

/// The fixture's contributed datatype id — asserted absent from every app source (d).
const DROPIN_DATATYPE: &str = "dropin-acceptance/widget";
const DROPIN_PKG: &str = "dropin-acceptance-pkg";
const DROPIN_COMPUTE: &str = "compute/dropin.py";

async fn get_array(server: &TestServer, token: &str, path: &str) -> Vec<Value> {
    let resp = server
        .client
        .get(server.api_url(path))
        .bearer_auth(token)
        .send()
        .await
        .unwrap_or_else(|e| panic!("GET {path}: {e}"));
    assert_eq!(resp.status().as_u16(), 200, "authed GET {path} → 200");
    let body: Value = resp.json().await.expect("json");
    body.as_array().expect("array dump").clone()
}

#[tokio::test]
async fn a_separate_repo_package_dropped_at_runtime_is_discovered_with_no_rebuild() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    let processors_dir = server.data_dir().join("processors");
    assert!(
        processors_dir.is_dir(),
        "the server extracted the seed processors folder at boot: {}",
        processors_dir.display()
    );

    // The fixture datatype must NOT exist before the drop-in (fresh id).
    let before = get_array(&server, &admin, "/datatypes").await;
    assert!(
        !before.iter().any(|d| d["id"] == DROPIN_DATATYPE),
        "the fixture datatype is absent before the drop-in"
    );

    // ── Drop a fresh, separate-repo package into the extracted folder AT RUNTIME. ──
    let pkg = write_dropin_fixture(&processors_dir, DROPIN_PKG, DROPIN_DATATYPE, DROPIN_COMPUTE);

    // Trigger a rescan via the admin reload endpoint (extract-no-clobber + scan +
    // arc-swap republish) — NO binary rebuild.
    let resp = server
        .client
        .post(server.api_url("/processors/reload"))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("admin reload");
    assert_eq!(resp.status().as_u16(), 200, "admin reload → 200");
    let reload: Value = resp.json().await.expect("reload json");

    // (b) — the reload response lists the fixture package ok:true.
    let packages = reload["packages"].as_array().expect("packages array");
    assert!(
        packages.iter().any(|p| p["id"] == DROPIN_PKG && p["ok"] == true),
        "the dropped-in package is loaded ok in the reload response: {packages:?}"
    );

    // (a) — its datatype lattice edge / title / viewer is registered.
    let types = get_array(&server, &admin, "/datatypes").await;
    let dt = types
        .iter()
        .find(|d| d["id"] == DROPIN_DATATYPE)
        .expect("the fixture datatype is now resolvable via GET /datatypes");
    assert_eq!(dt["extends"], "data", "the lattice edge (extends data) is registered");
    assert_eq!(dt["title"], "Drop-in widget", "its manifest title is carried");
    assert_eq!(dt["is_abstract"], false, "concrete datatype");
    let viewers = dt["viewers"].as_array().expect("viewers array");
    assert!(
        viewers.iter().any(|v| v["view_kind_id"] == "dropin-widget-view"),
        "its declared viewer edge is registered: {viewers:?}"
    );

    // (b) — GET /api/processors lists the package ok:true …
    let listed = get_array(&server, &admin, "/processors").await;
    assert!(
        listed.iter().any(|p| p["id"] == DROPIN_PKG && p["ok"] == true),
        "GET /api/processors lists the dropped-in package ok: {listed:?}"
    );
    // … and its converter is in the extension registry (GET /api/extensions).
    let exts = get_array(&server, &admin, "/extensions").await;
    let ext = exts
        .iter()
        .find(|e| e["id"] == DROPIN_PKG)
        .expect("the fixture extension manifest is listed");
    let converters = ext["contributes"]["converters"].as_array().expect("converters");
    let conv = converters
        .iter()
        .find(|c| c["id"] == format!("{DROPIN_PKG}-convert"))
        .expect("the fixture converter is registered");
    assert_eq!(conv["run"]["entry"], DROPIN_COMPUTE, "run.entry points at the folder compute");

    // (c) — the compute travels WITH the package AND RUNS FROM THE FOLDER (M5): the
    // converter's `run.entry` resolves THROUGH the real compute resolver
    // (`sandbox::processors::resolve_in`, the exact path the runner + recorder use) over
    // the extracted folder — proving the bytes are READ FROM THE FOLDER (INV-7), not just
    // that the file exists. (The actual bwrap EXEC of those bytes is the rootfs-gated
    // dataset suite; this proves the resolve/read leg the runner depends on.)
    let compute_path = pkg.join(DROPIN_COMPUTE);
    assert!(compute_path.is_file(), "the co-located compute file is on disk");
    let on_disk = std::fs::read_to_string(&compute_path).expect("read the dropped compute");
    let resolved = cytoanalyst::modules::sandbox::processors::resolve_in(&processors_dir, DROPIN_COMPUTE)
        .expect("the dropped-in compute resolves THROUGH the runner's resolver, from the folder");
    assert_eq!(resolved.package, DROPIN_PKG, "resolves in the dropped package");
    assert_eq!(
        resolved.script.as_ref(),
        on_disk,
        "the resolver reads the DROPPED bytes from the folder (INV-7), not a fixture"
    );
    assert!(
        matches!(resolved.language, cytoanalyst::modules::sandbox::spec::Language::Python),
        "the language is inferred from the folder-discovered compute"
    );

    // (c2) — H2: the dropped package's `ui/*.yaml` view-spec is SERVED from the runtime
    // folder by `GET /api/processors/packages`, so the workbench renders its declarative
    // UI with ZERO FE rebuild. Assert the fixture's view-spec bytes are actually served.
    let resp = server
        .client
        .get(server.api_url("/processors/packages"))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("GET /processors/packages");
    assert_eq!(resp.status().as_u16(), 200, "authed GET /processors/packages → 200");
    let assets: Value = resp.json().await.expect("packages json");
    let pkgs = assets["packages"].as_array().expect("packages array");
    let served = pkgs
        .iter()
        .find(|p| p["id"] == DROPIN_PKG)
        .expect("the dropped package's assets are served from the runtime folder (H2)");
    assert!(
        served["manifest"].as_str().unwrap_or_default().contains(DROPIN_PKG),
        "the manifest bytes are served from the folder"
    );
    // A served view is `{path, text}`, not a bare string. It became an object when an
    // analysis' `ui:` list had to SELECT and ORDER its view files — a list of texts with no
    // identity cannot be selected from. Both halves are asserted, because each carries a
    // distinct claim and the old string form could only make one of them:
    //   `text` — the bytes really came from the runtime folder (the zero-rebuild property
    //            this test exists for),
    //   `path` — they are ADDRESSABLE, which is what an `ui: [...]` entry resolves against.
    // A regression that served the right bytes under the wrong path would have passed the
    // previous assertion.
    let views = served["views"].as_array().expect("views array");
    let hit = views
        .iter()
        .find(|v| {
            v["text"]
                .as_str()
                .unwrap_or_default()
                .contains(&format!("{DROPIN_PKG}.view"))
        })
        .unwrap_or_else(|| {
            panic!(
                "the dropped ui/*.yaml view-spec is served from the runtime folder \
                 (zero-rebuild render): {views:?}"
            )
        });
    let path = hit["path"].as_str().unwrap_or_default();
    assert!(
        path.starts_with("ui/") && path.ends_with(".yaml"),
        "a served view must carry its PACKAGE-RELATIVE path so an `ui:` entry can name it, \
         got {path:?}"
    );

    // (d) — INV-3 STATIC assertion: NO app/builtin server source file names the
    // fixture datatype id. The binary carries no domain knowledge of it; it lives
    // ONLY in the runtime-dropped package (+ this test).
    let src_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut offenders = Vec::new();
    scan_for_id(&src_dir, DROPIN_DATATYPE, &mut offenders);
    assert!(
        offenders.is_empty(),
        "no app/builtin source names the fixture datatype id (INV-3): {offenders:?}"
    );
}

/// Recursively scan every `.rs` under `dir` for `needle`; push the paths that contain
/// it into `hits` (the INV-3 "the binary knows nothing about this datatype" proof).
fn scan_for_id(dir: &std::path::Path, needle: &str, hits: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            scan_for_id(&path, needle, hits);
        } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
            if let Ok(text) = std::fs::read_to_string(&path) {
                if text.contains(needle) {
                    hits.push(path.display().to_string());
                }
            }
        }
    }
}
