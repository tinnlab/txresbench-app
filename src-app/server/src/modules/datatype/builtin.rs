//! The seed built-in datatype set — the SIX UNIVERSAL ROOTS ONLY (DEC-2). Every
//! domain datatype (single-cell/expression, embedding, clustering, de, report/qc,
//! sequence/fastq, the 10x/AnnData/MuData family, …) was moved OUT of here
//! into the processor-contributed `single-cell-types` DATA package
//! (`src-app/packages/single-cell-types/manifest.yaml`, ITEM-3..7) so the app
//! builtin knows NOTHING domain-specific (INV-3). What stays are the datatype-SYSTEM
//! primitives every app on the SDK needs: the abstract lattice roots + two concrete
//! opaque leaves. The merged registry (these roots ∪ the manifest contributions)
//! reproduces the former lattice field-for-field — see the field-parity /
//! no-regression tests (`tests/extensions/datatype_contribution_test.rs` +
//! `tests/datatype/mod.rs`).
//!
//! Each root is a `#[distributed_slice(DATATYPES)]` static — a new datatype is a
//! code entry (for a root) or a manifest entry (for a domain type), ZERO migration.

use linkme::distributed_slice;

use super::registry::{DatatypeEntry, DATATYPES};
use super::types::{Datatype, FileLayout, IngestSpec, LayoutKind, StorageSpec, ViewerRef};

// ------------------------- capability vocabulary -------------------------
// An OPEN string set. The ONLY capability const that stays in the app builtin is
// `sliceable` — a matrix-family TRAIT the `matrix` root's inherited `matrix-grid`
// viewer references (below), not domain knowledge (DEC-2). Every other capability
// (has-obs/has-var/modality/protein/atac/fragments/multimodal/categorical/
// obs-aligned) is a DOMAIN trait and now travels as a plain capability STRING on
// the contributed single-cell datatypes, not a const here.
pub const CAP_SLICEABLE: &str = "sliceable";

fn no_shape(_: &serde_json::Value) -> Result<(), String> {
    Ok(())
}

fn viewer(view_kind_id: &str, family: &str, consumes: &[&str]) -> ViewerRef {
    ViewerRef {
        view_kind_id: view_kind_id.into(),
        family: family.into(),
        consumes: consumes.iter().map(|s| s.to_string()).collect(),
    }
}

// ------------------------- abstract lattice roots -------------------------

fn data_dt() -> Datatype {
    Datatype {
        id: "data".into(),
        extends: None,
        title: "Data".into(),
        description: "The abstract root of every datatype.".into(),
        schema: serde_json::json!({}),
        storage: StorageSpec {
            layout: LayoutKind::OpaqueAsIs,
            format: "any".into(),
            file_layout: FileLayout::Single,
        },
        capabilities: vec![],
        axes: vec![],
        // No axes ⇒ no entity axis. The six lattice ROOTS are abstract gating
        // supertypes; a contributed datatype declares its own axes and names which of
        // them is the entity axis (`Datatype::entity_axis`).
        entity_axis: None,
        arrays: vec![],
        // No per-column display labels on a universal ROOT — a lookup keyed by column
        // name is DOMAIN data, and the app builtin carries none (DEC-2). A contributed
        // datatype declares its own; see `Datatype::labels`.
        labels: Default::default(),
        viewers: vec![],
        ingest: None,
        converters: vec![],
        input_requirements: None,
        is_abstract: true,
    }
}

/// The CONCRETE opaque byproduct leaf: a generic "just some bytes" artifact
/// (e.g. a converter's harvested `dataset-metadata` JSON sidecar). The abstract
/// `data` ROOT can never directly type an artifact (`validate_artifact_typing`
/// rejects abstract), so producers that want an opaque catch-all target THIS
/// concrete child instead of the root.
fn data_opaque_dt() -> Datatype {
    Datatype {
        id: "data/opaque".into(),
        extends: Some("data".into()),
        title: "Opaque data".into(),
        description: "A generic opaque byproduct blob, stored + served as-is.".into(),
        schema: serde_json::json!({}),
        storage: StorageSpec {
            layout: LayoutKind::OpaqueAsIs,
            format: "any".into(),
            file_layout: FileLayout::Single,
        },
        capabilities: vec![],
        viewers: vec![],
        ingest: None,
        converters: vec![],
        input_requirements: None,
        is_abstract: false,
        axes: vec![],
        // No axes ⇒ no entity axis. The six lattice ROOTS are abstract gating
        // supertypes; a contributed datatype declares its own axes and names which of
        // them is the entity axis (`Datatype::entity_axis`).
        entity_axis: None,
        arrays: vec![],
        // No per-column display labels on a universal ROOT — a lookup keyed by column
        // name is DOMAIN data, and the app builtin carries none (DEC-2). A contributed
        // datatype declares its own; see `Datatype::labels`.
        labels: Default::default(),
    }
}

fn tabular_dt() -> Datatype {
    Datatype {
        id: "tabular".into(),
        extends: Some("data".into()),
        title: "Tabular".into(),
        description: "Abstract row/column-structured data.".into(),
        schema: serde_json::json!({}),
        storage: StorageSpec {
            layout: LayoutKind::ColumnarTable,
            format: "parquet".into(),
            file_layout: FileLayout::Single,
        },
        capabilities: vec![],
        axes: vec![],
        // No axes ⇒ no entity axis. The six lattice ROOTS are abstract gating
        // supertypes; a contributed datatype declares its own axes and names which of
        // them is the entity axis (`Datatype::entity_axis`).
        entity_axis: None,
        arrays: vec![],
        // No per-column display labels on a universal ROOT — a lookup keyed by column
        // name is DOMAIN data, and the app builtin carries none (DEC-2). A contributed
        // datatype declares its own; see `Datatype::labels`.
        labels: Default::default(),
        viewers: vec![viewer("table", "deckgl", &[])],
        ingest: None,
        converters: vec![],
        input_requirements: None,
        is_abstract: true,
    }
}

fn matrix_dt() -> Datatype {
    Datatype {
        id: "matrix".into(),
        extends: Some("tabular".into()),
        title: "Matrix".into(),
        description: "Abstract 2-D numeric matrix (rows × columns).".into(),
        schema: serde_json::json!({}),
        storage: StorageSpec {
            layout: LayoutKind::ChunkedDense,
            format: "zarr".into(),
            file_layout: FileLayout::Single,
        },
        capabilities: vec![],
        axes: vec![],
        // No axes ⇒ no entity axis. The six lattice ROOTS are abstract gating
        // supertypes; a contributed datatype declares its own axes and names which of
        // them is the entity axis (`Datatype::entity_axis`).
        entity_axis: None,
        arrays: vec![],
        // No per-column display labels on a universal ROOT — a lookup keyed by column
        // name is DOMAIN data, and the app builtin carries none (DEC-2). A contributed
        // datatype declares its own; see `Datatype::labels`.
        labels: Default::default(),
        // The matrix-family viewer — inherited UP the lattice by every subtype
        // (the contributed single-cell matrix types inherit this `matrix-grid`).
        viewers: vec![viewer("matrix-grid", "deckgl", &[CAP_SLICEABLE])],
        ingest: None,
        converters: vec![],
        input_requirements: None,
        is_abstract: true,
    }
}

// ------------------------- concrete opaque roots -------------------------

fn report_html_dt() -> Datatype {
    Datatype {
        id: "report/html".into(),
        extends: Some("data".into()),
        title: "HTML report".into(),
        description: "An opaque HTML report blob, served as-is.".into(),
        schema: serde_json::json!({}),
        storage: StorageSpec {
            layout: LayoutKind::OpaqueAsIs,
            format: "html".into(),
            file_layout: FileLayout::Single,
        },
        capabilities: vec![],
        axes: vec![],
        // No axes ⇒ no entity axis. The six lattice ROOTS are abstract gating
        // supertypes; a contributed datatype declares its own axes and names which of
        // them is the entity axis (`Datatype::entity_axis`).
        entity_axis: None,
        arrays: vec![],
        // No per-column display labels on a universal ROOT — a lookup keyed by column
        // name is DOMAIN data, and the app builtin carries none (DEC-2). A contributed
        // datatype declares its own; see `Datatype::labels`.
        labels: Default::default(),
        viewers: vec![viewer("report", "html", &[])],
        ingest: Some(IngestSpec {
            extensions: vec!["html".into(), "htm".into()],
            magic_hex: vec![],
        }),
        converters: vec![],
        input_requirements: None,
        is_abstract: false,
    }
}

fn file_upload_dt() -> Datatype {
    Datatype {
        id: "file/upload".into(),
        extends: Some("data".into()),
        title: "Uploaded file".into(),
        description: "The pre-sniff upload root: a freshly-uploaded blob before its \
                      concrete datatype is detected (sniff). Concrete so a real upload \
                      row may carry it before promotion to a sniffed type."
            .into(),
        schema: serde_json::json!({}),
        storage: StorageSpec {
            layout: LayoutKind::OpaqueAsIs,
            format: "any".into(),
            file_layout: FileLayout::Single,
        },
        capabilities: vec![],
        axes: vec![],
        // No axes ⇒ no entity axis. The six lattice ROOTS are abstract gating
        // supertypes; a contributed datatype declares its own axes and names which of
        // them is the entity axis (`Datatype::entity_axis`).
        entity_axis: None,
        arrays: vec![],
        // No per-column display labels on a universal ROOT — a lookup keyed by column
        // name is DOMAIN data, and the app builtin carries none (DEC-2). A contributed
        // datatype declares its own; see `Datatype::labels`.
        labels: Default::default(),
        viewers: vec![],
        ingest: None,
        converters: vec![],
        input_requirements: None,
        is_abstract: false,
    }
}

// ------------------------- registrations (roots only) -------------------------

macro_rules! seed {
    ($static:ident, $id:literal, $extends:expr, $ctor:ident, $validate:ident) => {
        #[distributed_slice(DATATYPES)]
        static $static: DatatypeEntry = DatatypeEntry {
            id: $id,
            extends: $extends,
            constructor: $ctor,
            validate_shape: $validate,
        };
    };
}

seed!(DT_DATA, "data", None, data_dt, no_shape);
seed!(
    DT_DATA_OPAQUE,
    "data/opaque",
    Some("data"),
    data_opaque_dt,
    no_shape
);
seed!(DT_TABULAR, "tabular", Some("data"), tabular_dt, no_shape);
seed!(DT_MATRIX, "matrix", Some("tabular"), matrix_dt, no_shape);
seed!(
    DT_REPORT_HTML,
    "report/html",
    Some("data"),
    report_html_dt,
    no_shape
);
seed!(
    DT_FILE_UPLOAD,
    "file/upload",
    Some("data"),
    file_upload_dt,
    no_shape
);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::datatype::registry::DatatypeRegistry;

    // The SIX universal roots the app builtin keeps (DEC-2). Every other type is
    // domain and lives in a contributed manifest.
    const ROOTS: [(&str, Option<&str>, bool); 6] = [
        ("data", None, true),
        ("data/opaque", Some("data"), false),
        ("tabular", Some("data"), true),
        ("matrix", Some("tabular"), true),
        ("report/html", Some("data"), false),
        ("file/upload", Some("data"), false),
    ];

    // ITEM-3: the code-seeded slice is now EXACTLY the six universal roots — no
    // domain datatype survives in `builtin.rs`. The slice builds a valid,
    // single-rooted lattice; the DOMAIN lattice is proven separately over the
    // MERGED registry (TEST-7 / TEST-22).
    #[test]
    fn slice_is_exactly_the_six_universal_roots() {
        let r = DatatypeRegistry::build_from_slice().expect("roots-only slice is a valid lattice");
        assert_eq!(
            r.len(),
            ROOTS.len(),
            "the code-seeded slice carries ONLY the roots"
        );
        for (id, extends, is_abstract) in ROOTS {
            let dt = r.get(id).unwrap_or_else(|| panic!("root `{id}` resolves"));
            assert_eq!(dt.extends.as_deref(), extends, "`{id}` extends");
            assert_eq!(dt.is_abstract, is_abstract, "`{id}` is_abstract");
        }
        // No domain type is code-seeded any longer.
        for domain in [
            "single-cell/expression",
            "single-cell/anndata",
            "embedding",
            "clustering",
            "report/qc",
            "single-cell/matrix-mtx",
        ] {
            assert!(
                r.get(domain).is_none(),
                "domain type `{domain}` must NOT be code-seeded"
            );
        }
    }

    // The `sliceable` capability const stays on the `matrix` root (its inherited
    // `matrix-grid` viewer consumes it); the root viewers resolve up the lattice.
    #[test]
    fn matrix_root_keeps_sliceable_viewer() {
        let r = DatatypeRegistry::build_from_slice().unwrap();
        let mg = r
            .viewers_for("matrix")
            .into_iter()
            .find(|v| v.view_kind_id == "matrix-grid")
            .expect("the matrix root carries the matrix-grid viewer");
        assert!(
            mg.consumes.iter().any(|c| c == CAP_SLICEABLE),
            "matrix-grid consumes `sliceable`"
        );
        // `tabular` root carries the `table` viewer, inherited by `matrix`.
        let tab: Vec<String> = r
            .viewers_for("matrix")
            .iter()
            .map(|v| v.view_kind_id.clone())
            .collect();
        assert_eq!(
            tab,
            vec!["matrix-grid", "table"],
            "matrix inherits `table` from tabular"
        );
    }

    // Roots-only file layouts: report/html is a single blob (opaque leaf).
    #[test]
    fn root_file_layouts() {
        let r = DatatypeRegistry::build_from_slice().unwrap();
        assert_eq!(r.file_layout_for("report/html"), Some(FileLayout::Single));
        assert_eq!(r.file_layout_for("data/opaque"), Some(FileLayout::Single));
    }
}
