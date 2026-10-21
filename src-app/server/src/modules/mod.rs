//! CytoAnalyst domain + platform modules.
//!
//! Each module self-registers via `#[distributed_slice(MODULE_ENTRIES)]`
//! (linkme). Declaring the module here is enough to link its registration.

pub mod permissions;

pub mod account;
// `admin` — the cross-account admin surface (Tier-0 of the Admin Console epic). NOT
// saas-gated: accounts + `is_admin` exist in every build, so cross-account admin does
// too (the cross-account BILLING key lives in the saas-gated `billing` module).
pub mod admin;
pub mod app;
// `billing` (B2) is the self-serve Stripe payments layer. `#[cfg(feature = "saas")]`
// so it compiles OUT of the desktop/default build (INV-5 / §8): the module, the
// Stripe client, the routes and the `MODULE_ENTRIES` registration are all physically
// absent without the feature. The `accounts` billing COLUMNS its migration adds exist
// in BOTH builds (build.rs scans the migration tree regardless of the feature).
#[cfg(feature = "saas")]
pub mod billing;
pub mod datatype;
pub mod dataset;
pub mod drafts;
pub mod extensions;
// `features` — the runtime feature-flags subsystem (Admin Console epic #40). NOT
// saas-gated: runtime toggles are a general admin capability in every build (mirrors
// `admin`). Its `feature_flags` migration is discovered by build.rs like every module's.
pub mod features;
pub mod file;
pub mod health;
pub mod mcp;
pub mod rootfs;
pub mod sandbox;
// NOTE (artifact-model ITEM-13): the `tiledb_serve` module — the native in-process
// array reader (`ArraySource` trait + libtiledb FFI + the `NATIVE_ARRAY_BACKENDS`
// registry) — was DELETED along with its `tiledb_serve` Cargo feature and the
// `CYTO_TILEDB_LIB` env var. INV-1: the server never opens a byte for meaning, so it
// links no format-parsing library at all. Artifact bytes are served as bytes
// (`GET /artifacts/{id}/data[/{*member}]`) and decoded in the browser.
pub mod jobs;
pub mod provenance;
pub mod project;
pub mod sync;
pub mod user;
pub mod workstore;

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use ziee_framework::MODULE_ENTRIES;

    /// Every module's `order` must be UNIQUE across the whole linked set.
    ///
    /// `ziee_framework::create_modules` sorts `MODULE_ENTRIES` with a *stable*
    /// `sort_by_key(|e| e.order)`. A stable sort leaves tied elements in their
    /// input sequence — and the input is a linkme distributed slice, whose
    /// sequence is link order. Link order carries no source-level guarantee and
    /// shifts with unrelated code changes.
    ///
    /// Module order is route-registration order, which is `openapi.json`
    /// path-emission order. So a tie makes the generated spec nondeterministic:
    /// the tied modules' path blocks swap position between builds, producing a
    /// large pure-relocation diff (identical paths + schemas, different key
    /// order) that intermittently fails merge-gate C3 (regen-parity). That
    /// exact tie (`project` and `workstore` both at 25) cost five spurious
    /// "regen" commits before it was diagnosed.
    ///
    /// Distinct orders make the sort a TOTAL order, so link order provably
    /// cannot influence module order or the emitted spec. If you are adding a
    /// module and this test fails, pick an unused `order` — do not "fix" it by
    /// reordering declarations, which does not control link order.
    #[test]
    fn module_order_is_unique() {
        let mut by_order: BTreeMap<i32, Vec<&'static str>> = BTreeMap::new();
        for entry in MODULE_ENTRIES.iter() {
            by_order.entry(entry.order).or_default().push(entry.name);
        }

        let ties: Vec<String> = by_order
            .iter()
            .filter(|(_, names)| names.len() > 1)
            .map(|(order, names)| {
                let mut names = names.clone();
                names.sort_unstable();
                format!("  order {order}: {}", names.join(", "))
            })
            .collect();

        assert!(
            ties.is_empty(),
            "modules share an `order`, so their relative order is decided by linkme's \
             link order (nondeterministic) rather than by the declared order. This makes \
             the generated openapi.json path order unstable and intermittently fails \
             merge-gate C3 (regen-parity). Give each module a distinct `order`:\n{}",
            ties.join("\n")
        );
    }

    /// The sorted module order must be fully determined by the declared `order`
    /// values alone — i.e. sorting by `order` and sorting by `(order, name)`
    /// must agree. This is the direct statement of the invariant that
    /// `create_modules`' stable sort needs in order to be reproducible, and it
    /// stays true only while `module_order_is_unique` holds.
    #[test]
    fn sorted_module_order_is_link_order_independent() {
        let mut by_key: Vec<_> = MODULE_ENTRIES.iter().collect();
        by_key.sort_by_key(|e| e.order);

        let mut total: Vec<_> = MODULE_ENTRIES.iter().collect();
        total.sort_by_key(|e| (e.order, e.name));

        let by_key: Vec<&str> = by_key.iter().map(|e| e.name).collect();
        let total: Vec<&str> = total.iter().map(|e| e.name).collect();

        assert_eq!(
            by_key, total,
            "module order is not determined by `order` alone — the framework's stable \
             sort_by_key(order) disagrees with a total sort by (order, name), so the \
             result depends on linkme's link order"
        );
    }
}
