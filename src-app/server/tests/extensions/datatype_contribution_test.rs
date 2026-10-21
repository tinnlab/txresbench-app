//! TEST-1 [ITEM-1] — a manifest-CONTRIBUTED datatype is merged into the live
//! datatype registry (DEC-19/DEC-20-amended: DOMAIN datatypes are extension-declared,
//! not `builtin.rs`-registered) and is resolvable over the REST surface.
//!
//! Full production path: a real spawned server builds the merged registry at boot
//! from the baked `src-app/packages/*/manifest.yaml` tree (Rust-builtin lattice
//! roots ∪ manifest-declared domain types), then serves it over the
//! `projects::use`-gated `GET /api/datatypes`. Here we assert `annotation-table`
//! (declared ONLY in the `anndata-import` manifest, never in `builtin.rs`) shows up
//! ALONGSIDE the Rust built-ins with ROLE-NOT-PRIMARY semantics — it is a SUPPORTING
//! input, not a primary/dataset-input type.
//!
//! The collision-fails-boot half of ITEM-1 (a manifest datatype whose id collides
//! with a core root aborts the registry build) is a unit test elsewhere
//! (`datatype/registry.rs` / `extensions/loader.rs`); here we assert the merged
//! registry + the REST surface, which need a live server.

use serde_json::Value;

use super::setup_admin;
use crate::common::TestServer;

#[tokio::test]
async fn manifest_datatype_merges_into_registry_with_role_not_primary_semantics() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;

    // ── GET /datatypes: the merged registry dump the FE mirror + pickers read. ──
    let resp = server
        .client
        .get(server.api_url("/datatypes"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("GET /datatypes");
    assert_eq!(resp.status().as_u16(), 200, "authed registry dump → 200");
    let types: Value = resp.json().await.expect("datatypes json");
    let arr = types.as_array().expect("the registry is a JSON array");
    let ids: Vec<&str> = arr.iter().filter_map(|d| d["id"].as_str()).collect();

    // The Rust-registered lattice ROOTS are present …
    assert!(ids.contains(&"data"), "the `data` root is Rust-registered: {ids:?}");
    assert!(ids.contains(&"matrix"), "the `matrix` root is Rust-registered: {ids:?}");
    // … and a manifest-contributed DOMAIN type (moved out of `builtin.rs` into the
    // `single-cell-types` package, Slice 2) resolves in the merged registry too.
    assert!(
        ids.contains(&"single-cell/expression"),
        "a manifest-contributed domain type is present: {ids:?}"
    );

    // … and the MANIFEST-contributed `annotation-table` is merged in ALONGSIDE them
    // (the DEC-19 modular seam: a domain/supporting datatype needs no core edit).
    assert!(
        ids.contains(&"annotation-table"),
        "the manifest-declared `annotation-table` datatype is merged into the registry: {ids:?}"
    );
    let ann = arr
        .iter()
        .find(|d| d["id"] == "annotation-table")
        .expect("the annotation-table descriptor is resolvable via GET /datatypes");
    assert_eq!(ann["extends"], "data", "annotation-table extends the `data` root");
    assert_eq!(ann["title"], "Annotation table", "carries its manifest title");
    assert_eq!(
        ann["is_abstract"], false,
        "annotation-table is CONCRETE (an artifact can be of it), not an abstract gating supertype"
    );

    // ROLE-NOT-PRIMARY, observable half #1: it declares NO primary sniff `ingest`
    // extensions, so a generic `.csv` primary upload still sniffs to `de` — the
    // annotation-table is resolved by CONTEXT (a supporting file's kind), never as a
    // primary sniff/upload target.
    let ingest = &ann["ingest"];
    let no_sniff_extensions = ingest.is_null()
        || ingest["extensions"]
            .as_array()
            .map(|e| e.is_empty())
            .unwrap_or(true);
    assert!(
        no_sniff_extensions,
        "annotation-table registers NO primary sniff extensions (not a primary upload target): {ingest}"
    );

    // ROLE-NOT-PRIMARY, definitive half #2: the extension registry declares
    // annotation-table as a SUPPORTING accept on the h5ad-import converter, while the
    // single-cell primaries are role=primary. This is the authoritative role tag.
    let resp = server
        .client
        .get(server.api_url("/extensions"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("GET /extensions");
    assert_eq!(resp.status().as_u16(), 200, "authed extensions dump → 200");
    let exts: Value = resp.json().await.expect("extensions json");
    let anndata = exts
        .as_array()
        .expect("extensions is an array")
        .iter()
        .find(|e| e["id"] == "anndata-import")
        .expect("the anndata-import extension is baked");
    let accepts = anndata["contributes"]["converters"][0]["accepts"]
        .as_array()
        .expect("the h5ad-import converter declares accepts");

    let ann_accept = accepts
        .iter()
        .find(|a| a["type_id"] == "annotation-table")
        .expect("annotation-table is a declared accept of the import converter");
    assert_eq!(
        ann_accept["role"], "supporting",
        "annotation-table is a SUPPORTING input (role-not-primary), never a primary dataset input"
    );
    let primary = accepts
        .iter()
        .find(|a| a["type_id"] == "single-cell/anndata")
        .expect("the single-cell/anndata primary is a declared accept");
    assert_eq!(
        primary["role"], "primary",
        "the dataset's main file type is role=primary — the contrast that makes annotation-table's supporting role meaningful"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST-7 [ITEM-5/1/2 · INV-6] — contribution COMPLETENESS / field-parity.
//
// Every one of the 15 DOMAIN datatypes moved out of `builtin.rs` (Slice 2) into the
// `single-cell-types` DATA package must resolve field-for-field vs the `f56299d`
// code-seeded values — title, `extends`, `is_abstract`, ancestors, `viewers_for`
// (INCL. inherited), `axes`, capabilities — over the MERGED registry
// boot builds. AND each matrix-family type's declared `schema` must be an ENFORCED
// validator that REJECTS a malformed shape and accepts a valid one (proving the
// viewers + validator all TRAVEL as DATA, not just the title).
//
// `selector_map` LEFT this parity table: artifact-model ITEM-14 removed it (and
// `tiers`) from the core `StorageSpec` — §0.3 lists both under Deleted — so there is
// no field left to compare. The removal is now COMPLETE on BOTH sides: the manifests
// no longer spell the keys, and the manifest-facing shapes no longer accept them, which
// is asserted below as a REJECTION check (the accept-and-discard `RetiredDeclaration`
// seam that briefly bridged the two is gone). This is a pure in-process registry build
// (no server needed): the manifests are baked into the test binary, so
// `build_from_embedded()` reproduces production's boot merge.
#[test]
fn test7_contributed_domain_types_reproduce_f56299d_field_for_field() {
    use cytoanalyst::modules::datatype::registry::DatatypeRegistry;
    use cytoanalyst::modules::extensions::types::DatatypeContribution;

    let reg = DatatypeRegistry::build_from_embedded().expect("merged registry builds");

    // ITEM-14 REJECTION: the retired keys are gone from the manifest-facing shapes,
    // which are `deny_unknown_fields`, so a contribution still spelling either one
    // FAILS TO PARSE rather than parsing into nothing. The merged registry built above
    // is the positive control (every shipped manifest is clean); the two parses below
    // are the negative control that the denial is real and not vacuous.
    let clean = r#"{"id":"x/t","title":"T","description":"d",
        "storage":{"layout":{"kind":"columnar_table"},"format":"parquet","file_layout":"single"}}"#;
    serde_json::from_str::<DatatypeContribution>(clean)
        .expect("the retired-key-free shape still parses — the rejections below are not vacuous");
    // The VALUES are deliberately empty: `deny_unknown_fields` rejects on the KEY, before
    // it ever looks inside, so a domain-shaped selector value would add a domain noun to
    // the census for no assertive power at all.
    for retired in [r#""selector_map":{}"#, r#""tiers":[]"#] {
        let with_key = format!(r#""format":"parquet",{retired}"#);
        let dirty = clean.replace(r#""format":"parquet""#, &with_key);
        let err = serde_json::from_str::<DatatypeContribution>(&dirty).expect_err(
            "a manifest still declaring a retired storage key must be REFUSED (ITEM-14); \
             accepting it silently would resurrect the accept-and-discard seam",
        );
        assert!(
            err.to_string().contains("unknown field"),
            "expected an unknown-field denial, got: {err}"
        );
    }

    let expr_wire = serde_json::to_value(reg.get("single-cell/expression").expect("type resolves"))
        .expect("datatype serializes");
    let storage = expr_wire["storage"].as_object().expect("storage object");
    assert!(
        storage.contains_key("layout") && storage.contains_key("file_layout"),
        "storage lost its surviving fields — the absence checks below would be vacuous"
    );
    for retired in ["selector_map", "tiers"] {
        assert!(
            !storage.contains_key(retired),
            "a manifest-declared `storage.{retired}` travelled onto the merged datatype; \
             ITEM-14 deleted it from the contract entirely"
        );
    }

    // (id, title, extends, ancestors, viewers_for-ordered,
    //  axes (name,key_label), capabilities-must-contain)
    struct Expect {
        id: &'static str,
        title: &'static str,
        extends: &'static str,
        ancestors: &'static [&'static str],
        viewers: &'static [&'static str],
        axes: &'static [(&'static str, &'static str)],
        caps: &'static [&'static str],
    }
    let mgt: &[&str] = &["matrix-grid", "table"]; // matrix-family inherited viewers
    let sc_axes: &[(&str, &str)] = &[("cells", "barcode"), ("genes", "gene_id")];
    // The per-modality peers measure over a different second axis than the RNA types do.
    let feat_axes: &[(&str, &str)] = &[("cells", "barcode"), ("features", "feature_id")];
    // The UPLOAD/EXPORT containers sit under `data/opaque`, so they inherit no viewer.
    let opaque_anc: &[&str] = &["data/opaque", "data"];

    // MAINTENANCE NOTE. This table went STALE and RED and stayed that way: phase 5 moved the
    // axes onto the analysable types (`ddd75828`) and re-parented the upload containers to
    // `data/opaque` (`d842da5f`) without touching it, so its expected parents and axes were
    // both wrong. It failed on the FIRST row. Derive these values from the tree (dump
    // `reg.get`/`ancestors`/`viewers_for` for every id) rather than editing them by hand from
    // memory — that is how the previous values were produced and how they went wrong.
    let table: Vec<Expect> = vec![
        Expect { id: "single-cell/expression", title: "Expression matrix", extends: "matrix",
            ancestors: &["matrix", "tabular", "data"], viewers: mgt, axes: sc_axes,
            caps: &["sliceable", "has-obs", "has-var"] },
        Expect { id: "single-cell/counts", title: "Count matrix (raw)", extends: "single-cell/expression",
            ancestors: &["single-cell/expression", "matrix", "tabular", "data"], viewers: mgt, axes: sc_axes,
            caps: &["sliceable", "has-obs", "has-var"] },
        Expect { id: "single-cell/normalized", title: "Expression matrix (normalized)", extends: "single-cell/expression",
            ancestors: &["single-cell/expression", "matrix", "tabular", "data"], viewers: mgt, axes: sc_axes,
            caps: &["sliceable", "has-obs", "has-var"] },
        Expect { id: "single-cell/protein", title: "Surface protein (ADT)", extends: "single-cell/expression",
            ancestors: &["single-cell/expression", "matrix", "tabular", "data"], viewers: mgt, axes: feat_axes,
            caps: &["sliceable", "has-obs", "has-var", "modality", "protein"] },
        Expect { id: "single-cell/atac", title: "ATAC (peak matrix)", extends: "single-cell/expression",
            ancestors: &["single-cell/expression", "matrix", "tabular", "data"], viewers: mgt, axes: feat_axes,
            caps: &["sliceable", "has-obs", "has-var", "modality", "atac", "fragments"] },
        Expect { id: "single-cell/modality", title: "Modality (generic)", extends: "single-cell/expression",
            ancestors: &["single-cell/expression", "matrix", "tabular", "data"], viewers: mgt, axes: feat_axes,
            caps: &["sliceable", "has-obs", "has-var", "modality"] },
        Expect { id: "single-cell/multimodal", title: "Multi-modal container", extends: "data",
            ancestors: &["data"], viewers: &[], axes: feat_axes,
            caps: &["multimodal", "modality"] },
        // INV-7: an UPLOAD/EXPORT container. `data/opaque` (never `matrix`), so no inherited
        // viewer and no matrix-family gating; axis IDENTITY only; and — as of the package's
        // 0.8.0 — no capabilities at all (`caps: &[]` is a weak "must-contain" check, so the
        // real assertion is the INV-7 block after this loop).
        Expect { id: "single-cell/anndata", title: "AnnData", extends: "data/opaque",
            ancestors: opaque_anc, viewers: &[], axes: sc_axes, caps: &[] },
        Expect { id: "embedding", title: "Embedding", extends: "matrix",
            ancestors: &["matrix", "tabular", "data"], viewers: &["embedding-scatter", "matrix-grid", "table"],
            axes: &[("cells", "barcode"), ("dims", "dim_index")], caps: &["obs-aligned", "plottable-xy"] },
        Expect { id: "clustering", title: "Clustering", extends: "tabular",
            ancestors: &["tabular", "data"], viewers: &["table"], axes: &[("cells", "barcode")],
            caps: &["categorical", "obs-aligned"] },
        Expect { id: "metadata-column", title: "Metadata column", extends: "tabular",
            ancestors: &["tabular", "data"], viewers: &["table"], axes: &[("cells", "barcode")],
            caps: &["obs-aligned", "continuous-column", "metadata-column-family"] },
        Expect { id: "report/qc", title: "QC report", extends: "report/html",
            ancestors: &["report/html", "data"], viewers: &["qc-review", "report"], axes: &[], caps: &[] },
        Expect { id: "sequence/fastq", title: "FASTQ reads", extends: "data",
            ancestors: &["data"], viewers: &[], axes: &[], caps: &[] },
        // The other INV-7 container. Its ONE capability is a DISPATCH MARKER the upload
        // planner resolves (`manifest_group_specs` → `types_with_capability`), not a claim
        // about the bytes — which is the distinction the block below tests.
        Expect { id: "single-cell/matrix-mtx", title: "10x matrix (MTX trio)", extends: "data/opaque",
            ancestors: opaque_anc, viewers: &[], axes: sc_axes, caps: &["mtx-trio-target"] },
    ];
    // WS-R5: the message used to read "all 15 domain types are covered by the parity table".
    // That was false, and it was ALSO this certification's pinned ANCHOR — so the string could
    // not be corrected without a matching re-anchor in both ledgers, which is why it stood.
    // `single-cell-types` contributes SIXTEEN types; `cell-set` (added at its 0.3.0) has never
    // been in this table. The number is now stated as the partial coverage it is.
    //
    // artifact-model ITEM-38 RE-ANCHOR, 15/16 -> 14/15: the retired lossless multi-file store
    // type left the contributed manifest at its 0.6.0, taking one row out of this table and one
    // type out of the package. The uncovered type is unchanged. Both cardinality ledgers
    // (`CARDINALITY_CERTIFICATIONS` in `ui/scripts/lint-no-domain-in-builtin.mjs` and in
    // `server/tests/domain_surface/mod.rs`) pin THIS sentence, so they move with it — which is
    // exactly the two-sided edit the mechanism exists to force.
    assert_eq!(
        table.len(),
        14,
        "the parity table covers 14 of the 15 types single-cell-types contributes (cell-set is \
         NOT covered)"
    );

    for e in &table {
        let dt = reg.get(e.id).unwrap_or_else(|| panic!("contributed type `{}` resolves", e.id));
        // A CONCRETE artifact type is directly of each (never abstract).
        assert!(!dt.is_abstract, "`{}` is concrete", e.id);
        assert_eq!(dt.title, e.title, "`{}` title", e.id);
        assert_eq!(dt.extends.as_deref(), Some(e.extends), "`{}` extends", e.id);
        assert_eq!(reg.ancestors(e.id), e.ancestors, "`{}` ancestors chain", e.id);
        // viewers_for resolves the type's OWN viewers + every inherited one, ordered.
        let got_viewers: Vec<String> =
            reg.viewers_for(e.id).iter().map(|v| v.view_kind_id.clone()).collect();
        assert_eq!(got_viewers, e.viewers, "`{}` viewers_for (incl. inherited)", e.id);
        // axes (name + key_label) travel INLINE (the single-cell primaries).
        let got_axes: Vec<(String, String)> =
            dt.axes.iter().map(|a| (a.name.clone(), a.key_label.clone())).collect();
        let want_axes: Vec<(String, String)> =
            e.axes.iter().map(|(n, k)| (n.to_string(), k.to_string())).collect();
        assert_eq!(got_axes, want_axes, "`{}` axes", e.id);
        // capabilities travel as strings.
        for cap in e.caps {
            assert!(dt.has_capability(cap), "`{}` advertises capability `{cap}`", e.id);
        }
    }

    // One shared probe for the schema checks: a wrong-typed count field. Bound ONCE so the
    // (necessarily domain-named) key is written a single time, and so the opaque assertion and
    // its negative control below are provably the SAME value.
    let structure_probe = serde_json::json!({"cells": "not-an-integer"});

    // ── INV-7: an OPAQUE upload/export container declares NO INTERNAL STRUCTURE ──
    //
    // The `caps: &[]` field above is a "must-contain" list and therefore cannot express
    // "and nothing else", which is the whole claim here. These are the assertions with
    // teeth, and each names one thing the upload container used to declare while it extended
    // `matrix` — carried over unexamined when 0.7.0 changed its parent:
    //
    //   * capabilities  — three statements about bytes nobody has parsed (the exact strings
    //                     are the `forbidden` list below). Sliceable only after an import.
    //   * storage       — `chunked_sparse/csc`: the container's INTERNAL encoding.
    //   * schema        — a count-field object: the container's INTERNAL dimensions.
    //
    // Axis IDENTITY is deliberately NOT in this list — the rows above pin it per id, and
    // INV-7 in `docs/design/processor-manifest-ui-separation.md` says why: it is what a
    // supporting file aligns to at UPLOAD time, before anything is parsed.
    //
    // The container set is DERIVED from the lattice (`descendants` of the opaque root), not
    // listed — so the invariant covers every opaque type, including ones added later, and a
    // new container cannot be onboarded past it by simply not appearing in a literal.
    let opaque_root = "data/opaque";
    let opaque_containers = reg.descendants(opaque_root);
    assert!(
        opaque_containers.len() >= 2,
        "non-vacuity: expected the lattice to carry several `{opaque_root}` subtypes, got \
         {opaque_containers:?} — the per-container loop below would otherwise assert nothing"
    );
    for id in &opaque_containers {
        let dt = reg.get(id).expect("a derived id resolves");
        // (1) No capability that describes the CONTENTS. A `*-target` capability is EXEMPT:
        // that suffix names a ROLE the host resolves via `types_with_capability` (the upload
        // planner's trio target, the provenance selection target) — a fact about how the file
        // is ROUTED, never about the bytes. Anything else on an opaque type is a structure
        // claim. The explicit list after it is belt-and-braces for the three that were
        // actually declared, so a future `sliceable`-shaped name cannot slip past the rule.
        let structural: Vec<&String> = dt
            .capabilities
            .iter()
            .filter(|c| !c.ends_with("-target"))
            .collect();
        assert!(
            structural.is_empty(),
            "`{id}` is opaque and may not advertise what is INSIDE it (INV-7) — it declares \
             {structural:?}"
        );
        for forbidden in ["sliceable", "has-obs", "has-var"] {
            assert!(
                !dt.has_capability(forbidden),
                "`{id}` advertises `{forbidden}` — an un-imported container is not sliceable \
                 and has nothing readable inside it (INV-7)"
            );
        }
        // (2) Opaque STORAGE — not a claim about the internal encoding (`chunked_sparse/csc`
        // states exactly that). `layout` is a required field, so the honest value is the
        // assertion, not its absence.
        assert_eq!(
            dt.storage.layout.as_storage_layout(),
            "opaque",
            "`{id}` must declare an OPAQUE storage layout — anything else states how the \
             container is encoded INSIDE (INV-7)"
        );
        // (3) No enforced shape validator. A schema over the container's own dimensions is a
        // structure claim — and unreachable besides: `validate_shape` is only called from
        // `validate_artifact_typing` on the run-OUTPUT path, and nothing emits an artifact of
        // these datatypes. The NEGATIVE CONTROL below proves this line can fail.
        assert!(
            reg.validate_shape(id, &structure_probe).is_ok(),
            "`{id}` enforces a shape over its own internals (INV-7) — it must declare no `schema`"
        );
    }
    // (4) …and axis IDENTITY still travels, for exactly the containers the table says carry
    // it. Asserted HERE, in the same test that demands opacity, so a future "make it fully
    // opaque" edit that strips the axes fails alongside — conflating the two is precisely the
    // regression that cost 7 `dataset::supporting_*` tests. The expected names come from the
    // table rows above, so this adds no second copy of the vocabulary.
    let mut checked_axes = 0usize;
    for e in table.iter().filter(|e| e.extends == opaque_root) {
        let axes = reg.axes_for(e.id);
        let got: Vec<&str> = axes.iter().map(|a| a.name.as_str()).collect();
        let want: Vec<&str> = e.axes.iter().map(|(n, _)| *n).collect();
        assert!(!want.is_empty(), "`{}` is a container whose axis identity must survive", e.id);
        assert_eq!(
            got, want,
            "`{}` must still declare its axis IDENTITY — `dataset/routes.rs` validates a \
             supporting file's axis against `axes_for(dataset.datatype)`, and for an uploaded \
             container that datatype IS this one",
            e.id
        );
        checked_axes += 1;
    }
    assert!(checked_axes >= 2, "non-vacuity: expected ≥2 opaque containers in the table");
    // NEGATIVE CONTROL for (3): the SAME probe value is rejected by a type that declares a
    // schema, so the assertion above tests the schema's ABSENCE rather than a validator that
    // happens to accept everything.
    assert!(
        reg.validate_shape("single-cell/expression", &structure_probe).is_err(),
        "negative control: a type that DOES declare a schema rejects this probe, so the \
         opaque-container assertion above is not vacuous"
    );

    // The declared `schema` is an ENFORCED validator (DEC-6) — a wrong-typed / valid
    // shape is REJECTED / accepted for every matrix-family type that declares one.
    // The upload container was in this list until the package's 0.8.0 and is not any more: it
    // is opaque, its schema described its own internals, and the INV-7 block above now
    // asserts the removal.
    for id in [
        "single-cell/expression", "single-cell/counts", "single-cell/normalized",
    ] {
        assert!(reg.validate_shape(id, &serde_json::json!({})).is_ok(), "`{id}` accepts empty shape");
        assert!(reg.validate_shape(id, &serde_json::json!({"cells": 100, "genes": 2000})).is_ok(),
            "`{id}` accepts a valid cells/genes shape");
        assert!(reg.validate_shape(id, &serde_json::json!({"cells": "x"})).is_err(),
            "`{id}` REJECTS a wrong-typed `cells` (the schema is an enforced validator)");
        // A1: the `{ type: integer, minimum: 0 }` count fields restore the former
        // `validate_matrix_shape` non-negative reject — a NEGATIVE `cells`/`genes`
        // is rejected (a bare `{type:integer}` would have accepted it).
        assert!(reg.validate_shape(id, &serde_json::json!({"cells": -5})).is_err(),
            "`{id}` REJECTS a negative `cells` (minimum:0 restores the old non-negative check)");
        assert!(reg.validate_shape(id, &serde_json::json!({"genes": -1})).is_err(),
            "`{id}` REJECTS a negative `genes`");
    }
    // The per-modality peers enforce their own shape keys.
    assert!(reg.validate_shape("single-cell/protein", &serde_json::json!({"proteins": "x"})).is_err(),
        "protein REJECTS a wrong-typed `proteins`");
    assert!(reg.validate_shape("single-cell/atac", &serde_json::json!({"peaks": "x"})).is_err(),
        "atac REJECTS a wrong-typed `peaks`");
}

// TEST-13 [ITEM-12/ITEM-9] [acceptance] [invariant: INV-4] — SEPARABILITY drop-in.
//
// The headline separability proof: a REAL YAML processor package on the
// filesystem, in a directory OUTSIDE `src-app/packages`, declaring a
// BRAND-NEW datatype (`demo/widget`) purely as DATA, registers EVERYTHING
// (lattice edge, title, viewers, an ENFORCED schema-validator, axes) with ZERO
// edit to any app/builtin file — through the SAME public seam production boot
// uses (`ExtensionRegistry::from_manifests` → `to_datatype()` →
// `DatatypeRegistry::build_merged`; the runtime `build_from_embedded` is just
// this over the baked tree). Parsed with the runtime loader's own
// `serde_norway` parser, so a real package YAML drops in unchanged. A static
// grep then asserts NO app/builtin file names `demo/widget` (nothing was
// hardcoded to make it work).
#[test]
fn test13_out_of_tree_package_registers_a_brand_new_datatype_with_zero_builtin_edit() {
    use cytoanalyst::modules::datatype::registry::DatatypeRegistry;
    use cytoanalyst::modules::extensions::loader::ExtensionRegistry;
    use cytoanalyst::modules::extensions::types::ExtensionManifest;
    use std::io::Write;

    // A real out-of-tree package on the filesystem, under a temp dir that is NOT
    // `src-app/packages` — the "separate repo / drop-in folder" scenario.
    let root = std::env::temp_dir().join(format!(
        "cyto-separability-{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    ));
    let pkg_dir = root.join("demo-widgets");
    std::fs::create_dir_all(&pkg_dir).expect("create out-of-tree package dir");
    let manifest_path = pkg_dir.join("manifest.yaml");
    let manifest_yaml = r#"
id: demo-widgets
name: Demo Widgets
publisher: third-party
version: 0.1.0
apiVersion: "1.0"
contributes:
  datatypes:
    - id: demo/widget
      extends: data
      title: Demo widget
      description: A brand-new datatype declared entirely as external DATA.
      is_abstract: false
      schema:
        type: object
        required: [widgets]
        properties:
          widgets: { type: integer }
      storage:
        layout: { kind: opaque_as_is }
        format: binary
      viewers:
        - { view_kind_id: demo-canvas, family: html, consumes: [] }
      capabilities: [demo-cap]
      axes:
        - { name: parts, key_label: part_id }
"#;
    let mut f = std::fs::File::create(&manifest_path).expect("write manifest.yaml");
    f.write_all(manifest_yaml.as_bytes()).expect("write bytes");
    drop(f);

    // Load it exactly as the runtime does: read the FILE, parse with the loader's
    // own parser, fold into the extension registry, convert its datatype
    // contributions, and MERGE into the datatype registry (roots ∪ this package).
    let text = std::fs::read_to_string(&manifest_path).expect("read the out-of-tree manifest");
    let manifest: ExtensionManifest =
        serde_norway::from_str(&text).expect("the out-of-tree package parses");
    let ext_reg = ExtensionRegistry::from_manifests(vec![manifest])
        .expect("the out-of-tree package folds into the extension registry");
    let extra: Vec<_> = ext_reg
        .all()
        .iter()
        .flat_map(|m| m.contributes.datatypes.iter().map(|d| d.to_datatype()))
        .collect();
    let reg = DatatypeRegistry::build_merged(extra)
        .expect("the merged registry (roots ∪ drop-in package) builds");

    // ── EVERYTHING registered, with ZERO app/builtin edit ──
    // lattice edge + resolvability
    assert!(reg.get("demo/widget").is_some(), "the drop-in datatype resolves");
    assert!(reg.is_a("demo/widget", "data"), "its `extends: data` edge is in the lattice");
    let dt = reg.get("demo/widget").unwrap();
    assert_eq!(dt.title, "Demo widget", "its declared title travels");
    assert!(!dt.is_abstract, "concrete as declared");
    // viewers travel
    let viewers: Vec<String> =
        reg.viewers_for("demo/widget").iter().map(|v| v.view_kind_id.clone()).collect();
    assert!(viewers.contains(&"demo-canvas".to_string()), "its declared viewer travels: {viewers:?}");
    // the declared schema is an ENFORCED validator (DEC-6)
    assert!(
        reg.validate_shape("demo/widget", &serde_json::json!({"widgets": 3})).is_ok(),
        "the drop-in's schema ACCEPTS a valid shape"
    );
    assert!(
        reg.validate_shape("demo/widget", &serde_json::json!({"widgets": "x"})).is_err(),
        "the drop-in's schema REJECTS a wrong-typed field"
    );
    assert!(
        reg.validate_shape("demo/widget", &serde_json::json!({})).is_err(),
        "the drop-in's schema REJECTS a missing required field"
    );
    // axes travel
    let axes: Vec<String> =
        reg.axes_for("demo/widget").iter().map(|a| a.name.clone()).collect();
    assert_eq!(axes, vec!["parts"], "its declared axis travels");

    // ── static grep: NO app-builtin SOURCE file names `demo/widget` (D3) ──
    // INV-4's wording is "ZERO edit to any app or builtin file". The proof is
    // comprehensive: sweep the WHOLE app-builtin surface — every backend source
    // (`server/src/**`) and every FE workbench-builtin source
    // (`ui/src/modules/workbench/**`) — not just the four canonical datatype files.
    // Excluded: this diff's OWN out-of-tree processor packages (`processor-packages`
    // is not under either root anyway) and all test sources (a test may legitimately
    // name a fixture id, as THIS file does). If the drop-in worked with zero edit,
    // no production source can name its brand-new id.
    let server_src = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    let fe_workbench =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../ui/src/modules/workbench");
    let mut scanned = 0usize;
    for dir in [&server_src, &fe_workbench] {
        for path in collect_source_files(dir) {
            let src = std::fs::read_to_string(&path).unwrap_or_default();
            assert!(
                !src.contains("demo/widget"),
                "no app-builtin source may name the drop-in datatype — `{}` does (separability broken)",
                path.display()
            );
            scanned += 1;
        }
    }
    // Guard against a vacuous grep (a broken walk that scans nothing would pass).
    assert!(scanned > 50, "expected a broad app-builtin sweep, only scanned {scanned} files");

    let _ = std::fs::remove_dir_all(&root);
}

/// Recursively collect `.rs`/`.ts`/`.tsx` PRODUCTION sources under `dir`, skipping
/// test sources (`*.test.ts[x]`, `*_test.rs`, any `tests/` dir) and the out-of-tree
/// `processor-packages` (its whole point is to name domain ids as DATA). Used by
/// TEST-13's D3 comprehensive no-hardcode sweep.
fn collect_source_files(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if path.is_dir() {
            if name == "tests" || name == "processor-packages" || name == "__tests__" {
                continue;
            }
            out.extend(collect_source_files(&path));
        } else {
            let is_test = name.ends_with(".test.ts")
                || name.ends_with(".test.tsx")
                || name.ends_with("_test.rs");
            let is_source = name.ends_with(".rs")
                || name.ends_with(".ts")
                || name.ends_with(".tsx");
            if is_source && !is_test {
                out.push(path);
            }
        }
    }
    out
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-36 [ITEM-14 / DEC-4] — the per-column DISPLAY-LABEL lookup travels END TO END.
//
// `labels` is the ONE piece of the deleted `axes[].annotations` forecast that survived,
// because a raw column name → a human label is the one fact about a column that is NOT
// derivable from the data (DEC-4). It has now been found inert THREE times, each a layer
// deeper than the last: `hostCtx.resolveInputs` iterated the wrong key; `annotationsForAxis`
// keyed the lookup by a server-minted UUID no author can write; and — this one — the value
// never left the manifest at all, because `to_datatype()` did not copy it, `Datatype` had
// no field to copy it INTO, and the BUILD GATE's own mirror of the contribution schema is
// `deny_unknown_fields` WITHOUT the key, so a manifest that actually declared `labels`
// failed `cargo check` before any of that could matter.
//
// So this test walks every layer in ONE pass, through the same functions boot uses:
//
//   L1 BUILD GATE  `processor_manifest_lint::lint_processor_package` accepts the key
//   L2 PARSE       the runtime `ExtensionManifest`/`DatatypeContribution` parse keeps it
//   L3 to_datatype the conversion COPIES it onto the `Datatype`
//   L4 REGISTRY    `DatatypeRegistry::build_merged` (what boot runs) keeps it
//   L5 WIRE        the JSON `GET /api/datatypes` serves carries it
//
// Break ANY one of the five and this test fails at that step, naming it. A test that
// hand-builds a `Datatype { labels: … }` registry entry — which is what the two existing
// TEST-23 arms do on the TS side — passes with all five broken; that is exactly how the
// mechanism stayed dead through two rounds of fixing it.
//
// L6 (the FE consumer) is asserted separately by
// TEST-37 (`test37_the_generated_client_contract_carries_the_label_lookup`) below: the consumer reads
// `datatypeRegistry.get(id).labels`, and that registry is populated from the served wire
// through the GENERATED client type — so a stale regen breaks the chain one layer past L5.
#[test]
fn test36_column_labels_travel_from_manifest_to_the_served_datatype_wire() {
    use cytoanalyst::modules::datatype::registry::DatatypeRegistry;
    use cytoanalyst::modules::extensions::loader::ExtensionRegistry;
    use cytoanalyst::modules::extensions::types::ExtensionManifest;
    use std::io::Write;

    let root = std::env::temp_dir().join(format!(
        "cyto-labels-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let pkg_dir = root.join("label-demo");
    std::fs::create_dir_all(&pkg_dir).expect("create package dir");
    let manifest_path = pkg_dir.join("manifest.yaml");
    // DEC-4's flagship example, written exactly as an author would write it: the key is
    // the column's OWN NAME, not a catalog channel id.
    //
    // The fixture package is DELIBERATELY DOMAIN-NEUTRAL, keys included. What this test
    // proves is that a declared lookup map survives L1..L5 byte-for-byte; the map's KEYS
    // are payload, and naming them after one contributed package's columns would assert
    // nothing extra while re-importing that package's vocabulary into the app suite. Do
    // not "restore" domain-flavoured keys here — the surrounding ids (label-demo,
    // third-party, demo/labelled-column) were written neutral for the same reason.
    let manifest_yaml = r#"
id: label-demo
name: Label Demo
publisher: third-party
version: 0.1.0
apiVersion: "1.0"
contributes:
  datatypes:
    - id: demo/labelled-column
      extends: tabular
      title: Labelled column
      description: A datatype declaring per-column DISPLAY LABELS.
      is_abstract: false
      storage:
        layout: { kind: chunked_1d }
        format: zarr
      axes:
        - { name: rows, key_label: row_id }
      labels:
        pct_flagged: "% Flagged"
        n_units_scored: "Units scored"
"#;
    let mut f = std::fs::File::create(&manifest_path).expect("create manifest.yaml");
    f.write_all(manifest_yaml.as_bytes()).expect("write bytes");
    drop(f);

    // ── L1 BUILD GATE — the same lint `build.rs` panics on, over a real package dir. ──
    cytoanalyst::processor_manifest_lint::lint_processor_package(&pkg_dir).unwrap_or_else(|e| {
        panic!(
            "L1 BUILD GATE: a manifest declaring `labels` must pass the build lint, but it \
             was rejected — {e}"
        )
    });

    // ── L2 PARSE — the runtime parser keeps the declared map. ──
    let text = std::fs::read_to_string(&manifest_path).expect("read manifest");
    let manifest: ExtensionManifest =
        serde_norway::from_str(&text).expect("L2 PARSE: the package parses at runtime");
    let ext_reg =
        ExtensionRegistry::from_manifests(vec![manifest]).expect("folds into the extension registry");
    let contribution = ext_reg
        .all()
        .iter()
        .flat_map(|m| m.contributes.datatypes.iter())
        .find(|d| d.id == "demo/labelled-column")
        .expect("the contribution is registered")
        .clone();
    assert_eq!(
        contribution.labels.get("pct_flagged").map(String::as_str),
        Some("% Flagged"),
        "L2 PARSE: the declared label survives the manifest parse"
    );

    // ── L3 to_datatype — the conversion COPIES it (this is the layer that dropped it). ──
    let dt = contribution.to_datatype();
    let dt_json = serde_json::to_value(&dt).expect("the Datatype serializes");
    assert_eq!(
        dt_json.get("labels"),
        Some(&serde_json::json!({
            "pct_flagged": "% Flagged",
            "n_units_scored": "Units scored",
        })),
        "L3 to_datatype: `DatatypeContribution.labels` must be carried onto the `Datatype` \
         — got {dt_json:#}"
    );

    // ── L4 REGISTRY — the merged lattice boot builds keeps it. ──
    let reg = DatatypeRegistry::build_merged(vec![dt]).expect("the merged registry builds");
    let merged = reg
        .get("demo/labelled-column")
        .expect("L4 REGISTRY: the contributed type resolves");
    let merged_json = serde_json::to_value(merged).expect("the registry entry serializes");
    assert_eq!(
        merged_json.get("labels"),
        Some(&serde_json::json!({
            "pct_flagged": "% Flagged",
            "n_units_scored": "Units scored",
        })),
        "L4 REGISTRY: the label map survives the registry merge — got {merged_json:#}"
    );

    // ── L5 WIRE — `GET /api/datatypes` is `Json(reg.all().cloned())`, so THIS value is
    //    byte-for-byte what the FE registry is populated from. ──
    let served = serde_json::to_value(reg.all().into_iter().cloned().collect::<Vec<_>>())
        .expect("the registry dump serializes");
    let entry = served
        .as_array()
        .expect("array")
        .iter()
        .find(|d| d["id"] == "demo/labelled-column")
        .expect("L5 WIRE: the type is in the served dump");
    assert_eq!(
        entry["labels"]["pct_flagged"], "% Flagged",
        "L5 WIRE: the served descriptor carries the label lookup"
    );

    // ── NEGATIVE CONTROL — a lookup, not a schema claim (the property `annotations` lacked).
    //    A column the map does not mention is SILENT, and the map asserts nothing about it.
    assert!(
        entry["labels"].get("total_counts").is_none(),
        "an unmentioned column is silent — the map may never assert a column exists"
    );

    // ── NEGATIVE CONTROL — a type declaring NO labels serves an EMPTY map, never a
    //    borrowed one. (Catches a merge that back-fills labels from a supertype.)
    let bare = reg.get("tabular").expect("the `tabular` root resolves");
    assert_eq!(
        serde_json::to_value(bare).expect("serializes")["labels"],
        serde_json::json!({}),
        "a type that declares no labels serves an empty map"
    );

    let _ = std::fs::remove_dir_all(&root);
}

// TEST-37 [ITEM-14 / DEC-4] — the GENERATED CLIENT CONTRACT the FE consumer reads through.
//
// `WorkbenchDataSource`'s `columnLabel` dep is `datatypeRegistry.get(id)?.labels?.[name]`,
// and that registry is populated from `GET /api/datatypes` — so the label only reaches the
// consumer if the generated client describes the field. A backend field added WITHOUT
// re-running `just openapi-regen` leaves `tsc` green, every FE test green, and the value
// dropped on the floor at the last hop: the same silent-inertness failure one layer past
// L5. This asserts on the COMMITTED generated artifacts (the same technique
// `workstore/zarr_store_test.rs` uses for its route contract).
#[test]
fn test37_the_generated_client_contract_carries_the_label_lookup() {
    let ui = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../ui");
    let spec_path = ui.join("openapi/openapi.json");
    let spec: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(&spec_path)
            .unwrap_or_else(|e| panic!("read {}: {e}", spec_path.display())),
    )
    .expect("openapi.json is valid JSON");
    let datatype_schema = &spec["components"]["schemas"]["Datatype"];
    assert!(
        datatype_schema.is_object(),
        "the committed spec describes the `Datatype` schema"
    );
    assert!(
        datatype_schema["properties"]["labels"].is_object(),
        "L6 CONTRACT: the committed openapi.json must describe `Datatype.labels` — re-run \
         `just openapi-regen`. properties = {:#}",
        datatype_schema["properties"]
    );

    // And the generated TS the FE actually imports.
    let types_path = ui.join("src/api-client/types.ts");
    let types = std::fs::read_to_string(&types_path)
        .unwrap_or_else(|e| panic!("read {}: {e}", types_path.display()));
    let iface_start = types
        .find("export interface Datatype {")
        .expect("the generated client declares `interface Datatype`");
    let iface_end = iface_start
        + types[iface_start..]
            .find("\n}\n")
            .expect("the `Datatype` interface is terminated");
    assert!(
        types[iface_start..iface_end].contains("labels"),
        "L6 CONTRACT: the generated `Datatype` interface must declare `labels` — re-run \
         `just openapi-regen`"
    );
}
