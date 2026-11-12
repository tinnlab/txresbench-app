//! TEST-14 [ITEM-3] — `GET /api/extensions`: the backend-owned extension-manifest
//! registry control plane. Unauthenticated → 401; authenticated → 200 with the
//! boot-built registry, and the baked `anndata-import` extension carries its
//! `h5ad-import` converter exactly as authored in `manifest.yaml` (env, trigger,
//! accepts, produces cardinalities) — the wire contract the FE `workbenchRegistry`
//! projects. Drives the REAL server (its own baked registry), no mocking.

use serde_json::Value;

use super::setup_admin;
use crate::common::TestServer;

// GET /api/extensions is gated by projects::use (DEC-13, no new permission): an
// unauthenticated request is refused before any body is produced.
#[tokio::test]
async fn list_extensions_requires_auth() {
    let server = TestServer::spawn().await;
    setup_admin(&server).await;

    let resp = server
        .client
        .get(server.api_url("/extensions"))
        .send()
        .await
        .expect("unauth GET /extensions");
    assert_eq!(resp.status().as_u16(), 401, "no token → 401");
}

// The authed dump carries the baked registry; the anndata-import extension is
// present with its h5ad-import converter declaring env=single-cell, on-ingest
// trigger, the two accepted single-cell input types, and the produces
// cardinalities (expression=many, embedding=many, metadata-column=many,
// report/html=one).
//
// ITEM-27 removed `single-cell/soma` from that list. The store was the TRANSPOSE
// BUFFER the CSC matrix was streamed back out of, not a fifth product, so replacing
// the transpose retired it — and a manifest that still ADVERTISED it would be lying to
// every consumer of `/extensions` about what a run produces. The check below is
// therefore an ABSENCE assertion plus a tightened `produces.len()`, not a deletion.
#[tokio::test]
async fn list_extensions_returns_baked_anndata_import() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;

    let resp = server
        .client
        .get(server.api_url("/extensions"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("GET /extensions");
    assert_eq!(resp.status().as_u16(), 200, "authed dump → 200");
    let body: Value = resp.json().await.expect("extensions json");

    let extensions = body.as_array().expect("the dump is a JSON array");
    assert!(
        !extensions.is_empty(),
        "at least the anndata-import extension is baked"
    );

    let anndata = extensions
        .iter()
        .find(|e| e["id"] == "anndata-import")
        .expect("anndata-import extension present in the registry");
    assert_eq!(anndata["name"], "AnnData / 10x Import");
    assert_eq!(anndata["publisher"], "txr");
    // `apiVersion` keeps its manifest wire name (serde rename), not `api_version`.
    assert_eq!(
        anndata["apiVersion"], "1.0",
        "apiVersion serialized under its wire name"
    );
    // The manifest CONTRIBUTES the `annotation-table` supporting datatype (DEC-19,
    // amending DEC-20): the modular seam is active, so the datatypes array carries it
    // (the axes of the existing Rust single-cell types are still attached via a boot
    // overlay, not declared here — so `annotation-table` is the one contributed entry).
    let datatypes = anndata["contributes"]["datatypes"]
        .as_array()
        .expect("datatypes array");
    assert!(
        datatypes.iter().any(|d| d["id"] == "annotation-table"),
        "manifest contributes the annotation-table supporting datatype (DEC-19)"
    );

    let converters = anndata["contributes"]["converters"]
        .as_array()
        .expect("converters array");
    assert_eq!(converters.len(), 1, "one declared converter");
    let conv = &converters[0];
    assert_eq!(conv["id"], "h5ad-import");
    assert_eq!(conv["title"], "Import AnnData / 10x");
    assert_eq!(conv["trigger"], "on-ingest", "DEC-4: on-ingest vocabulary");
    // ITEM-23 / DEC-22/23: the converter declares the analysis-domain env image
    // (resolved by the sandbox env_image registry — see sandbox::env_image_test).
    assert_eq!(
        conv["env"], "single-cell",
        "declares the env image its manifest names"
    );

    // accepts: exactly the two input datatypes the manifest declares.
    let accepts: Vec<&str> = conv["accepts"]
        .as_array()
        .expect("accepts array")
        .iter()
        .map(|a| a["type_id"].as_str().expect("type_id string"))
        .collect();
    assert!(
        accepts.contains(&"single-cell/anndata"),
        "accepts single-cell/anndata: {accepts:?}"
    );
    assert!(
        accepts.contains(&"single-cell/matrix-mtx"),
        "accepts single-cell/matrix-mtx: {accepts:?}"
    );
    // The feature adds SUPPORTING accepts (the annotation-table aligned to the cells
    // and genes axes), so the converter now declares the two primaries PLUS two
    // supporting entries (DEC-6/ITEM-6).
    assert!(
        accepts.contains(&"annotation-table"),
        "accepts the annotation-table supporting type: {accepts:?}"
    );
    assert_eq!(
        accepts.len(),
        4,
        "two primary + two supporting (cells/genes annotation) accepts: {accepts:?}"
    );

    // produces: the static superset shape with per-output cardinalities (ITEM-10).
    let produces = conv["produces"].as_array().expect("produces array");
    let card_of = |datatype: &str| -> String {
        produces
            .iter()
            .find(|p| p["datatype"] == datatype)
            .unwrap_or_else(|| panic!("produces {datatype}: {produces:?}"))["cardinality"]
            .as_str()
            .expect("cardinality string")
            .to_string()
    };
    assert!(
        !produces.iter().any(|p| p["datatype"] == "single-cell/soma"),
        "ITEM-27 deleted the SOMA output; the manifest must not still advertise it: \
         {produces:?}"
    );
    assert_eq!(
        card_of("single-cell/expression"),
        "many",
        "expression CSC is 1-or-per-modality"
    );
    assert_eq!(card_of("embedding"), "many", "embeddings are 0..N");
    assert_eq!(
        card_of("metadata-column"),
        "many",
        "metadata columns are 0..N"
    );
    assert_eq!(
        card_of("report/html"),
        "one",
        "the QC report is exactly one"
    );
    assert_eq!(produces.len(), 4, "four declared produces entries");

    // The run spec routes to the baked python compute entry.
    assert_eq!(conv["run"]["kind"], "sandbox");
    assert_eq!(conv["run"]["runtime"], "python");
    assert_eq!(conv["run"]["entry"], "compute/h5ad_import.py");
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST-4 [covers: ITEM-1, ITEM-1b] — a package declaring `contributes.sections`
// survives the WHOLE backend path and reaches the FE verbatim.
//
// The path has two gates in series and this test crosses both: the loader LINTS a
// package first (`lint_processor_package`, the same validator `build.rs` panics on)
// and SKIPS it on failure, then PARSES the manifest into the runtime types. A
// `sections` key known to only one of the two would be invisible here — either the
// whole package silently vanishes from the registry (lint) or the key is dropped from
// the response (parse). So asserting the sections come back byte-for-byte is what
// proves the pair actually landed together, on the real production path, through a
// real spawned server rather than a unit-level deserialize.
// ─────────────────────────────────────────────────────────────────────────────

const SECTIONS_PKG: &str = "sections-acceptance-pkg";

/// A drop-in package whose ONLY contribution is Visualize sections — no analysis, no
/// datatype, no converter. It is written into the server's already-extracted
/// `<data_root>/processors/` at runtime, exactly as `write_dropin_fixture` does.
fn write_sections_fixture(processors_dir: &std::path::Path) -> std::path::PathBuf {
    let pkg = processors_dir.join(SECTIONS_PKG);
    std::fs::create_dir_all(pkg.join("ui")).expect("create the package ui dir");
    std::fs::write(
        pkg.join("manifest.yaml"),
        format!(
            "id: {SECTIONS_PKG}\n\
             name: Sections Acceptance Package\n\
             publisher: acme-labs\n\
             version: 0.1.0\n\
             apiVersion: \"1.0\"\n\
             contributes:\n\
             \x20 sections:\n\
             \x20   - id: acme.coordinates\n\
             \x20     title: Coordinates\n\
             \x20     pane: visualize\n\
             \x20     order: 10\n\
             \x20     collapsed: false\n\
             \x20     applies_to: [{{ capabilities: [plottable-xy] }}]\n\
             \x20     ui: [ui/coordinates.yaml]\n\
             \x20   - id: acme.minimal\n\
             \x20     title: Minimal\n\
             \x20     pane: visualize\n"
        ),
    )
    .expect("write manifest");
    std::fs::write(
        pkg.join("ui").join("coordinates.yaml"),
        format!("id: {SECTIONS_PKG}.coordinates\ntitle: Coordinates\n"),
    )
    .expect("write section view_spec");
    pkg
}

#[tokio::test]
async fn a_package_contributing_sections_loads_and_serves_them_verbatim() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    let processors_dir = server.data_dir().join("processors");
    assert!(
        processors_dir.is_dir(),
        "the server extracted the seed processors folder at boot: {}",
        processors_dir.display()
    );
    let pkg = write_sections_fixture(&processors_dir);
    assert!(pkg.join("manifest.yaml").is_file());

    let resp = server
        .client
        .post(server.api_url("/processors/reload"))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("admin reload");
    assert_eq!(resp.status().as_u16(), 200, "admin reload → 200");

    let resp = server
        .client
        .get(server.api_url("/extensions"))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("GET /extensions");
    assert_eq!(resp.status().as_u16(), 200, "authed dump → 200");
    let body: Value = resp.json().await.expect("extensions json");
    let extensions = body.as_array().expect("the dump is a JSON array");

    // NOT SKIPPED — the lint accepted the package, so it is in the registry at all.
    // (A `sections` key the lint did not know would have failed `lint_processor_package`
    // and dropped the whole package here, silently.)
    let ext = extensions
        .iter()
        .find(|e| e["id"] == SECTIONS_PKG)
        .unwrap_or_else(|| {
            panic!(
                "the sections package was SKIPPED by the loader — the lint half of the \
                 parser pair is missing. Registry ids: {:?}",
                extensions
                    .iter()
                    .map(|e| e["id"].as_str().unwrap_or("?"))
                    .collect::<Vec<_>>()
            )
        });

    // VERBATIM — every declared key round-trips through parse + re-serialize.
    let sections = ext["contributes"]["sections"]
        .as_array()
        .expect("contributes.sections is an array on the wire");
    assert_eq!(
        sections.len(),
        2,
        "both declared sections survive: {sections:?}"
    );

    let first = &sections[0];
    assert_eq!(first["id"], "acme.coordinates");
    assert_eq!(first["title"], "Coordinates");
    assert_eq!(
        first["pane"], "visualize",
        "the pane KIND, not an area/region/role"
    );
    assert_eq!(first["order"], 10.0);
    assert_eq!(first["collapsed"], false);
    assert_eq!(
        first["applies_to"][0]["capabilities"][0], "plottable-xy",
        "a capability-only selector — the cross-package binding, on the wire"
    );
    assert!(
        first["applies_to"][0]
            .get("type_id")
            .map_or(true, |v| v.is_null()),
        "a capability-only selector names no datatype id: {:?}",
        first["applies_to"][0]
    );
    assert_eq!(first["ui"][0], "ui/coordinates.yaml");

    // The minimal section: the three required keys, everything else defaulted.
    let second = &sections[1];
    assert_eq!(second["id"], "acme.minimal");
    assert_eq!(second["pane"], "visualize");
    assert!(
        second["order"].is_null(),
        "no declared order stays null on the wire"
    );
    assert_eq!(second["collapsed"], false);
    assert_eq!(
        second["applies_to"].as_array().map(|a| a.len()),
        Some(0),
        "an empty selector list, not a missing key"
    );

    // The package contributes NOTHING ELSE — a section needs no analysis and no
    // datatype to reach the FE, which is the property the whole seam rests on.
    for other in ["analyses", "datatypes", "converters"] {
        assert_eq!(
            ext["contributes"][other].as_array().map(|a| a.len()),
            Some(0),
            "the sections-only package declares no {other}"
        );
    }
}

// TEST-80 [covers: ITEM-65] — the SHIPPED sections-only package, read off the real tree.
//
// The test above proves the SEAM with a fixture it writes itself. This one proves the thing
// that actually ships, and the two are not interchangeable: a fixture can carry the shape
// while the shipped manifest drifts, and then the seam test passes about a package nobody
// installs. It reads the real files for the same reason the FE's TEST-88 reads the real
// view specs.
//
// The package is DISCOVERED from the directory, never NAMED. Naming it would carry a
// contributed package's vocabulary into the app tree — the rule the FE's own discovery guard
// states in as many words — and it would also make the test about one package rather than
// about the SHAPE. A second package of this shape is covered on the next run.
//
// The claim is ITEM-65's, stated precisely after the phase-2 correction: not "the first
// package declaring neither" (the two `_`-prefixed helper packages already declare
// `contributes: {}`, and one shipped package contributes converters only) but the first
// CONTRIBUTING package with no analysis and no datatype.
#[test]
fn a_shipped_package_contributes_only_visualize_sections() {
    let processors = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("server/ has a parent")
        .join("packages");

    // `serde_norway`, the SAME parser the runtime loader and the build lint use — never
    // `serde_yaml` (CODING_GUIDELINES §17), and never a second dialect that could disagree
    // with the two gates this test asserts alongside.
    let mut found = 0usize;
    for entry in std::fs::read_dir(&processors).expect("packages/ is readable") {
        let dir = entry.expect("a readable dir entry").path();
        // A `_`-prefixed directory is skipped from contribution entirely, so one of those
        // would satisfy every assertion below vacuously.
        let name = dir.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
        if !dir.is_dir() || name.starts_with('_') {
            continue;
        }
        let manifest_path = dir.join("manifest.yaml");
        if !manifest_path.exists() {
            continue;
        }
        let manifest: serde_norway::Value =
            serde_norway::from_str(&std::fs::read_to_string(&manifest_path).expect("manifest"))
                .expect("a shipped manifest parses");
        let contributes = &manifest["contributes"];
        let sections = match contributes.get("sections").and_then(|s| s.as_sequence()) {
            Some(s) if !s.is_empty() => s,
            _ => continue,
        };
        if contributes.get("analyses").is_some() {
            continue; // a package contributing BOTH is a different (also legal) shape
        }
        found += 1;

        for other in ["analyses", "datatypes", "converters", "actions", "views"] {
            assert!(
                contributes.get(other).is_none(),
                "ITEM-65: a sections-only package declares no {other} (in {name})"
            );
        }

        let mut capability_only = 0usize;
        for section in sections {
            assert_eq!(
                section["pane"].as_str(),
                Some("visualize"),
                "every section names the pane it joins (in {name})"
            );
            let files = section["ui"]
                .as_sequence()
                .expect("every section names its `ui:` files");
            assert!(!files.is_empty(), "a section with no view files is a header, not a section");
            for f in files {
                let rel = f.as_str().expect("a `ui:` entry is a path");
                // `ui/`, not any other folder — three discovery surfaces hardcode it
                // (DRIFT-1.8), so anything else resolves to nothing and the section
                // silently never renders.
                assert!(rel.starts_with("ui/"), "section view files live in `ui/`, got {rel}");
                assert!(dir.join(rel).exists(), "declared in `ui:` but missing on disk: {rel}");
            }
            for sel in section["applies_to"].as_sequence().into_iter().flatten() {
                // INV-18 — a selector states a KIND. The parsers refuse a producer key
                // outright; this asserts the shipped declarations do not even attempt one.
                for producer_key in ["analysis", "package", "processor", "consumes", "slot"] {
                    assert!(
                        sel.get(producer_key).is_none(),
                        "INV-18: a section applies to a KIND of data and never names a producer ({producer_key})"
                    );
                }
                if sel.get("capabilities").is_some()
                    && sel.get("type_id").is_none()
                    && sel.get("subtypes_of").is_none()
                {
                    capability_only += 1;
                }
            }
        }
        // ITEM-61 — the capability-only selector is not an academic case: a shipped section
        // uses one, which is what makes the FE's day-one pin a test about production.
        assert!(
            capability_only >= 1,
            "ITEM-61: the shipped sections declare a capability-only selector (in {name})"
        );
    }

    assert_eq!(
        found, 1,
        "ITEM-65 ships exactly one sections-only package today; a zero would make every \
         assertion above vacuous, and a change either way is a decision, not an accident"
    );
}

// ── TEST-86 (visualize-pane ITEM-69) — the rename moved the SOURCE, not the DATA ROOT ──
//
// ITEM-69 renames the in-tree package directory `src-app/processors/` → `src-app/packages/`.
// DEC-8b deliberately does NOT rename the RUNTIME extraction root: `<data_root>/processors`
// stays. That split is easy to state and easy to break in either direction, and BOTH
// directions are silent:
//
//   · If the SOURCE side had been missed, `include_dir!("$CARGO_MANIFEST_DIR/../packages")`
//     would fail to compile — loud. But a HALF-move (the tree moved, a scanner still
//     pointed at the old name) would compile and simply seed nothing.
//   · If the RUNTIME side had been renamed along with it, every existing install would
//     keep a fully populated `<data_root>/processors` that nothing reads, beside a new
//     empty `<data_root>/packages`, and reconciliation is seed-version-WINS-ONLY, so there
//     is no path that ever repairs it. That is a data migration, and it is not this
//     round's migration.
//
// The third clause is the one a rename could weaken without anyone noticing:
// `sandbox::processors` canonicalises a resolved file against that SAME runtime root to
// reject a symlink escape (the gate that stops a dropped package reading `/etc/shadow`
// into `/code`, OUTSIDE bwrap, with full server privilege). Pointing that gate at a root
// that no longer exists would make `canonicalize` fail — which happens to fail CLOSED
// today, but "the security gate errors for the wrong reason" is not a property to inherit
// by luck. So the escape is exercised for real against the post-rename root.
//
// Every subject here is DISCOVERED from the tree (the package set is read off disk and
// matched against the served registry), never named. Naming one would tie an app-side test
// to a contributed package's vocabulary — the same rule that decides what this app is
// allowed to spell.
#[tokio::test]
async fn packages_load_from_the_renamed_source_and_still_extract_to_the_processors_data_root() {
    // (1) THE SOURCE moved. Resolved from this crate's manifest dir — the same anchor
    //     `include_dir!` uses — so this is the very path the seed is baked from.
    let src_app = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .canonicalize()
        .expect("resolve src-app");
    let source_tree = src_app.join("packages");
    assert!(
        source_tree.is_dir(),
        "the contributed packages live at src-app/packages/ after ITEM-69"
    );
    assert!(
        !src_app.join("processors").exists(),
        "src-app/processors is GONE — a half-move leaves both, and the scanners disagree"
    );

    // The contributed package ids, READ OFF THE SOURCE TREE. `_`-prefixed folders are the
    // reserved helper packages (never contributed), and a `manifest.yaml` is what makes a
    // folder a package at all.
    let mut declared: Vec<String> = std::fs::read_dir(&source_tree)
        .expect("read the source tree")
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| !n.starts_with('_') && !n.starts_with('.'))
        .filter(|n| source_tree.join(n).join("manifest.yaml").is_file())
        .collect();
    declared.sort();
    assert!(
        declared.len() >= 5,
        "the source tree resolved almost nothing ({declared:?}) — a collapsed scan would make \
         every assertion below vacuous"
    );

    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;

    // (2) THE RUNTIME ROOT did not move (DEC-8b). The seed extracted into
    //     `<data_root>/processors`, and there is no `<data_root>/packages` beside it.
    let data_dir = server.data_dir();
    let processors_dir = data_dir.join("processors");
    assert!(
        processors_dir.join(".seed-manifest.json").is_file(),
        "the seed extracted into <data_root>/processors: {}",
        processors_dir.display()
    );
    assert!(
        !data_dir.join("packages").exists(),
        "the runtime root was NOT renamed — a second, empty root beside a populated one is \
         the migration DEC-8b refuses"
    );
    // The bytes that landed there came from the RENAMED source: every package the rename
    // commit moved is present in the extracted tree, by id.
    for id in &declared {
        assert!(
            processors_dir.join(id).join("manifest.yaml").is_file(),
            "`{id}` moved with the source tree but did not extract into the unchanged runtime \
             root at {}",
            processors_dir.display()
        );
    }

    // (3) …and the registry the server serves agrees, so this is the live load path and
    //     not just files on disk.
    let resp = server
        .client
        .get(server.api_url("/extensions"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("GET /extensions");
    assert_eq!(resp.status().as_u16(), 200);
    let body: Value = resp.json().await.expect("extensions body");
    let served: Vec<String> = body
        .as_array()
        .expect("extensions is an array")
        .iter()
        .filter_map(|e| e["id"].as_str())
        .map(|s| s.to_string())
        .collect();
    assert!(!served.is_empty(), "the served registry is empty after the move");
    for id in &served {
        assert!(
            declared.contains(id),
            "the registry serves `{id}`, which is not a package of the renamed source tree \
             {declared:?}"
        );
    }

    // (4) THE CONTAINMENT GATE still rejects an escape against that root. A dropped
    //     package whose compute file is a SYMLINK to a host file outside the root: the
    //     lexical guard passes (no `..`, not absolute), so only the canonical-confine
    //     gate can refuse it.
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let bait = data_dir.join("txr-secret-not-for-code.txt");
        std::fs::write(&bait, "DATABASE_URL=postgres://secret").expect("write the bait");
        let pkg = processors_dir.join("escape-pkg").join("compute");
        std::fs::create_dir_all(&pkg).expect("create the dropped package");
        symlink(&bait, pkg.join("steal.py")).expect("plant the symlink");

        let Err(err) = txresbench::modules::sandbox::processors::resolve_in(
            &processors_dir,
            "compute/steal.py",
        ) else {
            panic!("a symlink escaping the processors root must be REJECTED");
        };
        assert!(
            err.contains("escapes") || err.contains("symlink escape"),
            "the refusal names the escape (not an incidental IO error): {err}"
        );

        // POSITIVE CONTROL — the same call shape SUCCEEDS for a file that stays inside the
        // root, so the rejection above is the gate working and not the resolver being
        // broken against the post-rename root.
        std::fs::write(pkg.join("ok.py"), "print('ok')\n").expect("write an in-root script");
        let resolved = txresbench::modules::sandbox::processors::resolve_in(
            &processors_dir,
            "compute/ok.py",
        )
        .expect("an in-root script resolves");
        assert_eq!(resolved.script.as_ref(), "print('ok')\n");
    }
}
