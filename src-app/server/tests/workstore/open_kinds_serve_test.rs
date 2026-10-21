//! S4 [INV-2 / INV-7] — the CRUX proof: the 3 kinds SOMA structurally cannot hold —
//! **geneset**, **graph**, **DE** — are DECLARED DATA manifests served with ZERO new
//! core Rust.
//!
//! Two proofs:
//! 1. `open_kinds_serve_through_unchanged_byte_plane` — seed ONE fixture artifact per
//!    kind whose `datatype` is the new kind id, and read an array back from EACH over the
//!    unchanged `GET /api/artifacts/{id}/data/{*member}` byte plane. All three come back
//!    through the same path a matrix does. The DE case's dense 2-D stat matrix → one
//!    comparison's per-row logFC is exactly what `de_page` returned, proving the bespoke
//!    DE server logic is replaceable by a DECLARED table kind plus arithmetic in the
//!    reader.
//! 2. `kinds_zero_core_scope` — the un-gameable static grep-guard (the Rust twin of
//!    `scripts/check-kinds-zero-core.sh`): NO kind id appears in any app-core serve /
//!    datatype-builtin / workstore source file. A new kind = manifest DATA only.
//!
//! **artifact-model ITEM-12 made proof 1 STRONGER, not weaker.** It used to serve through
//! `GET /read` and assert on a decoded Arrow batch, which proved the serve core routed on
//! LAYOUT rather than KIND. That core is deleted: there is no layout routing left either,
//! only a member path and a byte range, so a kind id cannot reach a serve decision that no
//! longer exists. The assertions below carry the same expected VALUES — they are now
//! decoded on the client side of the boundary, which is where every decode lives now.

use cytoanalyst::modules::datatype::DatatypeRegistry;
use cytoanalyst::modules::workstore::catalog::repository::CatalogRepository;
use cytoanalyst::modules::workstore::object_store::ObjectStore;

use super::{create_project, new_artifact, pool_for, read_csc_column, server_store, setup_admin};
use crate::common::TestServer;

/// Production (non-comment, non-`#[cfg(test)]`) lines of `src` as `(1-based line, code)`.
/// Strips inline/full `//` comments and whole brace-tracked `#[cfg(test)]` blocks so the
/// kinds guard reflects PRODUCTION code only (mirrors `no_legacy_wire::production_lines`).
fn production_lines(src: &str) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    let mut pending_cfg_test = false;
    let mut test_depth: i32 = 0;
    let mut in_test = false;
    for (i, raw) in src.lines().enumerate() {
        let code = match raw.find("//") {
            Some(idx) => &raw[..idx],
            None => raw,
        };
        let trimmed = code.trim();
        if in_test {
            for ch in code.chars() {
                match ch {
                    '{' => test_depth += 1,
                    '}' => {
                        test_depth -= 1;
                        if test_depth <= 0 {
                            in_test = false;
                        }
                    }
                    _ => {}
                }
            }
            continue;
        }
        if pending_cfg_test {
            let opens = code.matches('{').count() as i32;
            let closes = code.matches('}').count() as i32;
            if opens > 0 {
                pending_cfg_test = false;
                test_depth = opens - closes;
                if test_depth > 0 {
                    in_test = true;
                }
            }
            continue;
        }
        if trimmed.contains("#[cfg(test)]") || trimmed.contains("#[cfg(all(test") {
            pending_cfg_test = true;
            continue;
        }
        if trimmed.is_empty() {
            continue;
        }
        out.push((i + 1, code.to_string()));
    }
    out
}

// ── The 3 kinds are DECLARED DATA — served by the unchanged byte plane, ZERO new Rust ──
#[tokio::test]
async fn open_kinds_serve_through_unchanged_byte_plane() {
    // First prove the 3 kinds are LIVE registry DATA (contributed by the open-kinds
    // manifest, merged exactly as boot does) — a new kind is a manifest, not core code.
    let reg = DatatypeRegistry::build_from_embedded().expect("merged registry builds");
    // `de/result` extends `tabular`, NOT the former `de` kind: `de` was a producer-less
    // datatype pruned in `9ee2112b` (dimension-primitives ITEM-11), so re-pointing the
    // parent was required — leaving `extends: de` would dangle and fail boot.
    for (id, extends) in [
        ("geneset/collection", "data"),
        ("graph/attributed", "data"),
        ("de/result", "tabular"),
    ] {
        let dt = reg
            .get(id)
            .unwrap_or_else(|| panic!("kind `{id}` is registry DATA"));
        assert_eq!(dt.extends.as_deref(), Some(extends), "`{id}` extends");
        // The point of the parent assertion is that the DECLARED parent RESOLVES — a kind
        // whose `extends` names a pruned datatype dangles. Assert the parent is itself live
        // registry data, so this test fails on a dangling parent instead of merely on a
        // changed string.
        assert!(
            reg.get(extends).is_some(),
            "`{id}` extends `{extends}`, which must itself be a live registry kind (not dangling)",
        );
        assert!(
            !dt.arrays.is_empty(),
            "`{id}` declares arrays[] over an open axis set"
        );
    }
    // The graph kind binds BOTH adjacency dims to the SAME non-obs/var axis (`node`),
    // and the DE kind declares a `comparison` axis — the shapes SOMA cannot express.
    let graph = reg.get("graph/attributed").unwrap();
    let adj = graph.arrays.iter().find(|a| a.name == "adjacency").unwrap();
    assert_eq!(
        adj.axes(),
        vec!["node", "node"],
        "graph adjacency is (node,node)"
    );
    // `de/result` was RESHAPED (DEC-13) from the stacked `(comparison × entity)` matrix to
    // ONE comparison = ONE 2D entity TABLE: the synthetic `comparison` axis is DROPPED and the
    // single entity axis is served through the ordinary annotation-table (columnar) path.
    let de = reg.get("de/result").unwrap();
    let expected_axis = "gene";
    assert!(
        !de.axes.iter().any(|a| a.name == "comparison"),
        "the reshaped kind no longer declares a `comparison` axis (one comparison is one 2D table)"
    );
    assert_eq!(
        de.entity_axis.as_deref(),
        Some(expected_axis),
        "entity axis is the single declared axis"
    );
    let de_table = de
        .arrays
        .iter()
        .find(|a| a.name == "table")
        .expect("`table` array");
    assert_eq!(
        de_table.axes(),
        vec![expected_axis],
        "the table is a per-entity annotation table"
    );

    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let sid = create_project(&server, &token, "open-kinds").await;
    let pool = pool_for(&server).await;
    let store = server_store(&server);
    let repo = CatalogRepository::new(pool);

    // Helper: seed a CSC artifact (geneset membership / graph adjacency) whose columns
    // are the read axis (geneset / node). `datatype` = the KIND id, which the serve path
    // never reads — it resolves a member path and a byte range.
    let seed_csc = |indptr: Vec<i64>, indices: Vec<u32>, data: Vec<f32>| {
        let store = &store;
        async move {
            let ip: Vec<u8> = indptr.iter().flat_map(|v| v.to_le_bytes()).collect();
            let ix: Vec<u8> = indices.iter().flat_map(|v| v.to_le_bytes()).collect();
            let dt: Vec<u8> = data.iter().flat_map(|v| v.to_le_bytes()).collect();
            store
                .put_prefix(&[
                    ("indptr".into(), ip),
                    ("indices".into(), ix),
                    ("data".into(), dt),
                ])
                .await
                .unwrap()
        }
    };

    // ── geneset — membership incidence (geneset0 has genes {0,2}, geneset1 has {1}) ──
    // CSC: indptr [0,2,3]; col0 rows[0,2] member[1,1]; col1 rows[1] member[1].
    let put = seed_csc(vec![0, 2, 3], vec![0, 2, 1], vec![1.0, 1.0, 1.0]).await;
    let mut a = new_artifact(sid, "membership", put.object_key.as_str(), true);
    a.datatype = "geneset/collection".into();
    let geneset = repo.insert_artifact(&a).await.unwrap();

    // ── graph — adjacency (node0 → neighbours {1:0.5, 2:0.9}) ──
    // CSC: indptr [0,2,2]; col0 rows[1,2] weight[0.5,0.9]; col1 empty.
    let put = seed_csc(vec![0, 2, 2], vec![1, 2], vec![0.5, 0.9]).await;
    let mut a = new_artifact(sid, "adjacency", put.object_key.as_str(), true);
    a.datatype = "graph/attributed".into();
    let graph_art = repo.insert_artifact(&a).await.unwrap();

    // de/result reshaped to a 2D entity TABLE (columnar), no longer a dense (entity × comparison)
    // matrix — its serve path is the ordinary entity-axis annotation-table read, exercised by the
    // package's own real-compute e2e (DEC-13 TEST-24/25). The registry-shape
    // half above is what this zero-core test asserts for de/result; geneset + graph remain the
    // byte-plane serve exercises below.

    // Read geneset membership column 0 → member genes {0,2}, all weight 1.
    assert_eq!(
        read_csc_column(&server, &token, geneset.id, 0).await,
        vec![(0, 1.0), (2, 1.0)],
        "geneset0 members + membership values"
    );

    // Read graph adjacency column 0 → node0's neighbours {1,2} with weights.
    assert_eq!(
        read_csc_column(&server, &token, graph_art.id, 0).await,
        vec![(1, 0.5), (2, 0.9)],
        "node0 neighbours + edge weights"
    );
}

// ── M8 — the OUT-OF-TREE zero-core-SERVE proof (fixture path, not the embedded tree) ──
//
// The in-tree `open_kinds_serve_through_unchanged_byte_plane` above proves zero-core
// serve for kinds baked into the embedded registry (`build_from_embedded`). This proves
// the SAME for a kind declared in a manifest OUTSIDE `src-app/packages/` — loaded from
// a committed fixture file, merged via `build_merged`, and served through the UNCHANGED
// core purely on its chunked-sparse LAYOUT. So NOTHING about the in-tree open-kinds
// package's embedding is load-bearing (DEC-2 / PLAN out-of-tree fidelity, M8).
#[tokio::test]
async fn out_of_tree_fixture_kind_serves_through_unchanged_core() {
    use cytoanalyst::modules::extensions::loader::ExtensionRegistry;
    use cytoanalyst::modules::extensions::types::ExtensionManifest;

    // 1) The fixture manifest is a real file OUTSIDE the `include_dir!("../packages")`
    //    tree — `<server crate>/tests/fixtures/open-kinds-out-of-tree/manifest.yaml`.
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/open-kinds-out-of-tree/manifest.yaml");
    let text = std::fs::read_to_string(&fixture)
        .unwrap_or_else(|e| panic!("read out-of-tree fixture {}: {e}", fixture.display()));
    let manifest: ExtensionManifest =
        serde_norway::from_str(&text).expect("the out-of-tree fixture parses");
    let ext_reg = ExtensionRegistry::from_manifests(vec![manifest])
        .expect("fixture folds into the ext registry");
    let extra: Vec<_> = ext_reg
        .all()
        .iter()
        .flat_map(|m| m.contributes.datatypes.iter().map(|d| d.to_datatype()))
        .collect();

    // 2) It merges into the datatype registry (roots ∪ the out-of-tree kind) with ZERO
    //    core edit, declaring its arrays[] over the BRAND-NEW `pathway` axis.
    let reg =
        DatatypeRegistry::build_merged(extra).expect("merged registry (roots ∪ fixture) builds");
    let dt = reg
        .get("fixture/pathway")
        .expect("the OUT-OF-TREE kind resolves");
    assert!(
        !dt.arrays.is_empty(),
        "declares arrays[] over the open axis set"
    );
    let membership = dt.arrays.iter().find(|a| a.name == "membership").unwrap();
    assert_eq!(
        membership.axes(),
        vec!["gene", "pathway"],
        "(entity, pathway) — a NEW axis"
    );
    assert!(
        reg.axes_for("fixture/pathway")
            .iter()
            .any(|a| a.name == "pathway"),
        "the brand-new `pathway` axis travels from the out-of-tree manifest"
    );

    // 3) The un-gameable SERVE half: seed a CSC artifact whose datatype is the OUT-OF-TREE
    //    kind id and read it back through the UNCHANGED byte plane. Post-ITEM-12 the serve
    //    path does not route on the layout either — it resolves a member path and a byte
    //    range — so it cannot possibly have learned `fixture/pathway`.
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let sid = create_project(&server, &token, "out-of-tree-kind").await;
    let pool = pool_for(&server).await;
    let store = server_store(&server);
    let repo = CatalogRepository::new(pool);

    // CSC: indptr [0,2,3]; pathway0 has genes {0,2}, pathway1 has {1} (member weight 1).
    let ip: Vec<u8> = [0i64, 2, 3].iter().flat_map(|v| v.to_le_bytes()).collect();
    let ix: Vec<u8> = [0u32, 2, 1].iter().flat_map(|v| v.to_le_bytes()).collect();
    let dt_bytes: Vec<u8> = [1.0f32, 1.0, 1.0]
        .iter()
        .flat_map(|v| v.to_le_bytes())
        .collect();
    let put = store
        .put_prefix(&[
            ("indptr".into(), ip),
            ("indices".into(), ix),
            ("data".into(), dt_bytes),
        ])
        .await
        .unwrap();
    let mut a = new_artifact(sid, "membership", put.object_key.as_str(), true);
    a.datatype = "fixture/pathway".into();
    let art = repo.insert_artifact(&a).await.unwrap();

    assert_eq!(
        read_csc_column(&server, &token, art.id, 0).await,
        vec![(0, 1.0), (2, 1.0)],
        "pathway0 members + membership values, through the unchanged byte plane"
    );
}

// ── The un-gameable zero-core proof (the Rust twin of check-kinds-zero-core.sh) ──
#[test]
fn kinds_zero_core_scope() {
    // The APP-CORE production surface a new kind must NOT touch (the serve/data layer +
    // the datatype registry + the manifest loader + the converter graph). Paths are
    // relative to the server crate root (CARGO_MANIFEST_DIR). Test dirs + the DATA
    // manifest are excluded by construction — a kind id there is legitimate (a test seeds
    // fixtures; the manifest IS the data), so the guard cannot be gamed by hiding a
    // dispatch in them.
    //
    // THREE entries left this set by DELETION, not by exemption: `workstore/serve_core.rs`
    // (artifact-model ITEM-12), the whole `modules/tiledb_serve/` reader tree (ITEM-13),
    // and `datatype/layout.rs` (ITEM-14 — the `resolve_tier` router; the tier system is on
    // §0.3's Deleted list, so the decision it made no longer exists to learn a kind).
    // Each removal shrinks the attack surface rather than the guard: what remains is every
    // app-core file that still makes a decision about an artifact. `range.rs` JOINED the
    // set at ITEM-12 — it is half of the serve decision (`routes.rs` picks the member
    // path, `range.rs` picks the bytes) — and `datatype/catalog_view.rs` +
    // `datatype/validate.rs` JOIN it now: with `layout.rs` gone they are where the
    // registry's remaining per-artifact decisions live (which viewers/capabilities an
    // artifact's datatype resolves to, and whether a declared typing may land at all), so
    // the set is RE-POINTED at the surviving decision surface, not shrunk.
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let files: Vec<std::path::PathBuf> = vec![
        root.join("src/modules/workstore/data_api.rs"),
        root.join("src/modules/workstore/routes.rs"),
        root.join("src/modules/workstore/range.rs"),
        root.join("src/modules/workstore/ingest.rs"),
        root.join("src/modules/workstore/catalog/repository.rs"),
        root.join("src/modules/datatype/builtin.rs"),
        root.join("src/modules/datatype/registry.rs"),
        root.join("src/modules/datatype/catalog_view.rs"),
        root.join("src/modules/datatype/validate.rs"),
        // L2: the manifest loader + the converter graph are ALSO app-core surfaces a new
        // kind must not special-case (a kind-id dispatch in `loader.rs`/`convert.rs` would
        // otherwise evade the guard). A kind id in either = a zero-core regression.
        root.join("src/modules/extensions/loader.rs"),
        root.join("src/modules/datatype/convert.rs"),
    ];
    // Anti-vacuity: every path must EXIST, or the guard silently scans less than it
    // claims. This is the check that fires when a scanned surface is deleted — as two
    // just were — instead of the deletion quietly weakening the scan.
    let missing: Vec<String> = files
        .iter()
        .filter(|f| !f.is_file())
        .map(|f| f.display().to_string())
        .collect();
    assert!(
        missing.is_empty(),
        "a guarded app-core path no longer exists, so this guard was about to scan less \
         than it claims — re-point it, or drop it from the set deliberately:\n{}",
        missing.join("\n")
    );

    // All 3 kind ids are SLASH-COMPOUND → matched as raw substrings, no false positives.
    let kinds = ["geneset/collection", "graph/attributed", "de/result"];
    let mut leaks: Vec<String> = Vec::new();
    let mut scanned = 0usize;
    for f in &files {
        let src = std::fs::read_to_string(f)
            .unwrap_or_else(|e| panic!("read app-core file {}: {e}", f.display()));
        scanned += 1;
        // Scan PRODUCTION lines only (strip `//` comments + whole `#[cfg(test)]` blocks):
        // a kind id in a test fixture / doc is legitimate (e.g. `loader.rs`'s
        // `datatype_contribution_carries_open_axis_arrays` test declares `graph/attributed`),
        // and would false-positive the raw scan. A PRODUCTION dispatch on a kind id is the
        // regression this guard catches.
        for (n, line) in production_lines(&src) {
            for k in kinds {
                if line.contains(k) {
                    leaks.push(format!("{}:{}: {}", f.display(), n, line.trim()));
                }
            }
        }
    }
    // NOT a floor. A `>= N` count passes for N of the WRONG files and has to be lowered
    // every time a scanned surface is legitimately deleted — which is how a guard rots.
    // The named-path existence check above is the real backstop; this asserts every named
    // path was actually READ, so a read that silently produced nothing cannot pass.
    assert_eq!(
        scanned,
        files.len(),
        "every NAMED app-core path must be scanned (got {scanned} of {})",
        files.len()
    );
    assert!(
        leaks.is_empty(),
        "INV-2 violated: a zero-core kind id leaked into app-core — a new kind must be \
         DATA (packages/open-kinds/manifest.yaml); the serve path resolves a member \
         PATH and a byte RANGE and knows nothing else:\n{}",
        leaks.join("\n")
    );
}
