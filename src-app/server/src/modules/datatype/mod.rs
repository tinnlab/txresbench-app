//! `datatype` — P2, the SEMANTIC layer over P1's `workstore` artifacts catalog.
//!
//! An open, self-registering datatype registry (Galaxy model: dataset ≡
//! analysis-output ≡ typed artifact) + a subtyping lattice + type-match gating +
//! layout-keyed storage + viewers-per-datatype dispatch + sniff/validate/convert.
//! P2 owns NO table (DEC-1): it gives MEANING to P1's `artifacts.datatype` TEXT
//! column (artifact-model ITEM-7 dropped `artifacts.storage_layout`; the layout a
//! datatype declares is now validated against the MANIFEST entry's declared layout
//! at ingest, not persisted a second time on the row). Built-ins self-register via
//! `#[distributed_slice(DATATYPES)]` and are folded into a process-wide
//! `DatatypeRegistry` at `init` — a new datatype is a code entry, zero migration.
//! Server-embedded core infrastructure (P1's ingest validation + every gating
//! decision depend on it) — always builds, no kill-switch (DEC-11).

use aide::axum::ApiRouter;
use linkme::distributed_slice;
use std::sync::Arc;

use txresbench_framework::{AppModule, ModuleContext, ModuleEntry, MODULE_ENTRIES};

pub mod builtin;
pub mod catalog_view;
pub mod convert;
// NOTE (artifact-model ITEM-14): `layout` — the `resolve_tier` router that picked a
// data-access TIER from a datatype's `tiers` + `selector_map` — was DELETED with the
// tier system itself. There is one transport now: `/artifacts/{id}/data[/{*member}]`
// serves opaque byte ranges and the client decodes (ITEM-12 / INV-1), so there is no
// tier to resolve. §0.3 lists *the tier system*, *`selector_map`* and *`tiers`* under
// Deleted; what remains of a datatype is the is-a lattice.
pub mod registry;
pub mod routes;
pub mod sniff;
pub mod types;
pub mod validate;

#[cfg(test)]
mod tests;

// The public API P1 (workstore) + the routes call.
pub use registry::{registry, try_registry, DatatypeRegistry, DATATYPES};
pub use sniff::{sniff, SNIFF_MAGIC_BYTES};
pub use types::AxisSpec;
pub use validate::validate_artifact_typing;

pub struct DatatypeModule;

impl AppModule for DatatypeModule {
    fn name(&self) -> &'static str {
        "datatype"
    }

    fn description(&self) -> &'static str {
        "Open datatype registry + subtyping lattice + type-match gating + viewer dispatch (TxResBench P2)."
    }

    fn init(&mut self, _ctx: &ModuleContext) -> Result<(), Box<dyn std::error::Error>> {
        // Build the registry from every discovered `#[distributed_slice(DATATYPES)]`
        // entry and publish it as the process-wide singleton. `init` runs (for ALL
        // modules) before any `register_routes`, so it is set before P1's ingest/list
        // handlers read it at request time. A malformed seed lattice FAILS BOOT with a
        // clear error (never a silent empty registry) — mirrors project-extension build.
        // Build the FULL lattice: the Rust-registered universal ROOTS (DEC-2) ∪ the
        // domain datatypes CONTRIBUTED by extension manifests (ITEM-1/5, DEC-19) —
        // read straight from the embedded manifest tree (not the extensions OnceCell)
        // so this does not depend on module init order (datatype = 17, extensions =
        // 18). The single-cell PRIMARY datatypes carry their `cells`/`genes` axes
        // INLINE in the `single-cell-types` manifest now (the former boot axis-overlay
        // is deleted). A manifest id colliding with a core root FAILS BOOT (fail-loud).
        let reg = DatatypeRegistry::build_from_embedded().map_err(|e| {
            Box::<dyn std::error::Error>::from(format!("datatype registry build failed: {e}"))
        })?;
        tracing::info!(types = reg.len(), "datatype registry built");
        registry::set_global_registry(Arc::new(reg));
        Ok(())
    }

    fn register_routes(&self, router: ApiRouter) -> ApiRouter {
        router.merge(routes::datatype_routes())
    }
}

#[distributed_slice(MODULE_ENTRIES)]
static DATATYPE: ModuleEntry = ModuleEntry {
    name: "datatype",
    // Before dataset(20)/workstore(25)/project(25): the registry is up before any
    // ingest/list handler that consults it (17/18/19 are free; 15=user, 16=file).
    order: 17,
    description: "Open datatype registry + subtyping lattice (TxResBench P2).",
    constructor: || Box::new(DatatypeModule),
};

#[cfg(test)]
mod boot_axis_tests {
    use super::*;

    // ITEM-3 / DEC-15: a datatype that IS analysable carries its axes INLINE (from the
    // `single-cell-types` manifest) — the former boot axis-overlay
    // (`single_cell_axis_overlays()`) is deleted. The MERGED registry (the one boot
    // publishes) exposes those axes without any overlay step.
    //
    // The axes moved OFF `single-cell/anndata`/`matrix-mtx` (now opaque — see the test
    // below) and ONTO the analysable types, where analysis actually runs. `axes_for` is
    // a FLAT lookup — it does not walk `extends` — so every analysable subtype declares
    // its own, and this test enumerates them rather than spot-checking one: a subtype
    // silently missing its axes cannot answer `rowAxisFor`, and the workbench then falls
    // back to the catalog's positional order with nothing said.
    #[test]
    fn analysable_single_cell_types_carry_axes_inline_on_merged_registry() {
        let reg = DatatypeRegistry::build_from_embedded().expect("merged registry builds");
        // (id, axis names, key labels). The ORDER pinned here is the manifest's, and it
        // is pinned as text — it is NOT what makes any of these the entity axis. Which
        // axis a value of the type has one PER is `Datatype::entity_axis`, declared by
        // NAME; see `every_multi_axis_datatype_declares_its_entity_axis` below.
        let expected: &[(&str, &[&str], &[&str])] = &[
            (
                "single-cell/expression",
                &["cells", "genes"],
                &["barcode", "gene_id"],
            ),
            (
                "single-cell/counts",
                &["cells", "genes"],
                &["barcode", "gene_id"],
            ),
            (
                "single-cell/normalized",
                &["cells", "genes"],
                &["barcode", "gene_id"],
            ),
            (
                "single-cell/protein",
                &["cells", "features"],
                &["barcode", "feature_id"],
            ),
            (
                "single-cell/atac",
                &["cells", "features"],
                &["barcode", "feature_id"],
            ),
            (
                "single-cell/modality",
                &["cells", "features"],
                &["barcode", "feature_id"],
            ),
            (
                "single-cell/multimodal",
                &["cells", "features"],
                &["barcode", "feature_id"],
            ),
            ("embedding", &["cells", "dims"], &["barcode", "dim_index"]),
            ("clustering", &["cells"], &["barcode"]),
            ("metadata-column", &["cells"], &["barcode"]),
        ];
        for (id, names, labels) in expected {
            let axes = reg.axes_for(id);
            let got_names: Vec<&str> = axes.iter().map(|a| a.name.as_str()).collect();
            assert_eq!(&got_names, names, "{id} axis names");
            let got_labels: Vec<&str> = axes.iter().map(|a| a.key_label.as_str()).collect();
            assert_eq!(&got_labels, labels, "{id} axis key labels travel");
        }
    }

    // Every datatype in the MERGED registry that declares SEVERAL axes must name which
    // of them is its ENTITY axis, and that name must be one of its own axes.
    //
    // This is written as an INVARIANT over the whole registry, not as a list of the ids
    // that happen to declare axes today, because the defect it closes is precisely the
    // one a list cannot see: the consumer used to take `axes[0]`, so a NEW multi-axis
    // datatype — contributed by a package this repo has never seen — silently inherited
    // a positional guess. A hand list would go green on the ids it names and say nothing
    // about the next one. The non-vacuity assertion below is what stops it passing on an
    // empty registry.
    //
    // A SINGLE-axis datatype is exempt: with one axis there is no choice to make, and
    // requiring the declaration anyway would be ceremony that a contributor gets wrong
    // in the only way that matters (naming the wrong axis is worse than naming none).
    #[test]
    fn every_multi_axis_datatype_declares_its_entity_axis() {
        let reg = DatatypeRegistry::build_from_embedded().expect("merged registry builds");
        let mut checked = 0usize;
        for dt in reg.all() {
            if dt.axes.len() < 2 {
                continue;
            }
            checked += 1;
            let names: Vec<&str> = dt.axes.iter().map(|a| a.name.as_str()).collect();
            let entity = dt.entity_axis.as_deref().unwrap_or_else(|| {
                panic!(
                    "datatype `{}` declares axes {names:?} and no `entity_axis`; its \
                     consumer would fall back to the catalog's positional order",
                    dt.id
                )
            });
            assert!(
                names.contains(&entity),
                "datatype `{}` declares `entity_axis: {entity}`, which is not one of \
                 its axes {names:?}",
                dt.id
            );
        }
        assert!(
            checked >= 10,
            "non-vacuity: the merged registry must actually CONTAIN multi-axis \
             datatypes for this invariant to mean anything (saw {checked})"
        );
    }

    // Axis identity is `name` + `key_label` and NOTHING else (owner 2026-07-28: "remove
    // the annotations from the axes, keep name and key_label"). WHICH columns exist on
    // an axis is read from the artifacts that landed (INV-5) — a datatype may not
    // forecast them.
    //
    // This is asserted on the TYPE, not on a manifest's text, because a YAML grep is the
    // guard that leaks: the deleted `annotations:` blocks could come back through any
    // other manifest, a different key name, or a default. `AxisSpec` having no field to
    // put them in is what makes it unrepresentable.
    //
    // The key list is SORTED before comparing, and that is not cosmetic. `serde_json::Map`
    // is a `BTreeMap` (`preserve_order` is enabled nowhere in this workspace), so its keys
    // come out alphabetical no matter what order the struct declares — an assertion
    // written against declaration order can never pass. The first version of this test was
    // written that way and only LOOKED right because `["annotations","key_label","name"]`
    // is alphabetical too, so the failure it reported was the real defect while the
    // assertion itself was also wrong. Sorting both sides pins the SET of fields, which is
    // the actual property, and survives the map implementation changing underneath it.
    #[test]
    fn axis_identity_carries_no_column_forecast() {
        let reg = DatatypeRegistry::build_from_embedded().expect("merged registry builds");
        let json =
            serde_json::to_value(reg.axes_for("single-cell/expression")).expect("axes serialize");
        let axes = json.as_array().expect("axes array");
        assert!(
            !axes.is_empty(),
            "non-vacuity: the fixture must HAVE an axis"
        );
        for axis in axes {
            let mut keys: Vec<&str> = axis
                .as_object()
                .expect("axis object")
                .keys()
                .map(|k| k.as_str())
                .collect();
            keys.sort_unstable();
            assert_eq!(
                keys,
                vec!["key_label", "name"],
                "an axis carries identity only — any extra field is a column forecast \
                 re-entering through the type",
            );
        }
    }

    // The OTHER half, and the one that has teeth (owner 2026-07-28: "we would never do
    // analysis on single-cell/anndata, we only use to export it … it is just an opaque
    // object for downloading").
    //
    // An import FORMAT is not a matrix. When `anndata`/`matrix-mtx` extended `matrix`
    // they inherited its capabilities, so every analysis whose `appliesTo` names a
    // matrix subtype was offered against a file the compute layer cannot open — the
    // launcher listed work that could only fail. Re-parenting them to `data/opaque` is
    // what withdraws that offer.
    //
    // Withholding their AXES is NOT part of that, and asserting it here was a mistake
    // that cost a working feature. `dataset/routes.rs` validates a supporting file's axis
    // against `reg.axes_for(dataset.datatype)` — and for an uploaded h5ad, that datatype
    // IS this container. Axis-less meant every axis was unknown, so attaching a per-cell
    // annotation CSV 422'd: 7 integration tests, and a real capability that exists
    // precisely at upload time, before anything is parsed.
    //
    // So the two properties are independent and are asserted independently: an import
    // format still DECLARES what its dimensions are (identity), and is still barred from
    // analysis (lattice position). Conflating them is what produced the regression.
    #[test]
    fn import_format_primaries_are_opaque_but_still_declare_axis_identity() {
        let reg = DatatypeRegistry::build_from_embedded().expect("merged registry builds");
        for id in ["single-cell/anndata", "single-cell/matrix-mtx"] {
            let parent = reg.get(id).and_then(|d| d.extends.clone());
            assert_eq!(
                parent.as_deref(),
                Some("data/opaque"),
                "{id} must extend data/opaque, never matrix — a matrix subtype inherits \
                 matrix capabilities and gets offered to every matrix analysis",
            );
            let axes = reg.axes_for(id);
            let names: Vec<&str> = axes.iter().map(|a| a.name.as_str()).collect();
            assert_eq!(
                names,
                vec!["cells", "genes"],
                "{id} must still declare its axis IDENTITY — a supporting file's axis is \
                 validated against this list, and an empty one 422s every attachment",
            );
        }
    }
}
