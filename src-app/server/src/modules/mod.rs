//! TxResBench domain + platform modules.
//!
//! Each module self-registers via `#[distributed_slice(MODULE_ENTRIES)]`
//! (linkme). Declaring the module here is enough to link its registration.

pub mod permissions;

// TxResBench: the ONE user-facing error-message sanitiser at the API
// boundary of the txr modules (qa-fixes4 ITEM-1) — no absolute path, no
// `<app_data>` placeholder, no internal tool name reaches the UI; the full
// text stays in the log and in the un-rendered `internal_detail` field.
pub mod err_sanitiser;

// TxResBench: the account/user-management/admin/billing SaaS modules were removed
// along with their registrations (single-user local app — see dev/docs/app-build-strip.md).
pub mod account;
pub mod localsession;
// The runtime toggles subsystem (Admin Console epic #40) — a general admin
// capability in every build (mirrors `admin`). Its migration is discovered by
// build.rs like every other module's.
pub mod features;
pub mod file;
// TxResBench: the shared, stateless file layer — browser-decoded two-table
// validation (tidy-2.0 semantics), marker joins/units, per-patient coverage,
// the canonical bundle rows for the engine and embedded template/example
// assets. DB-free, stateless, boot-validated embed (like method_catalogue).
pub mod file_validator;
// TxResBench: the run engine — one analysis = one persisted run row
// (config + input snapshot + selected methods/models), per-method sandboxed
// stacks through the `sandbox` seam, run-scoped logs + SSE progress, the
// contract predictions + produced-model surface, and the sticky analysis
// config store. Depends on the in-process providers ordered before it
// (method_catalogue 47, file_validator 48); its own tables are module-owned
// migrations applied at boot like every module's.
pub mod execution_engine;
// TxResBench: the saved-model home — named sets of produced /model trees
// (content-addressed, immutable), .txr import/export, verified reuse
// resolution for the engine, per-model eligibility for the shared list.
// Depends on the in-process providers ordered before it (method_catalogue 47,
// execution_engine 49); its own tables are module-owned migrations applied at
// boot like every module's.
pub mod model_store;
// TxResBench: the run-history home — the K screen's searchable, filterable,
// bounded-paged record view over the engine's run tables (read-only
// projection), the keep-copies retention policy (preference + explicit
// copy-clear operations) and the data-usage figure. Depends on the
// in-process providers ordered before it (method_catalogue 47,
// execution_engine 49, model_store 50); its own tables are module-owned
// migrations applied at boot like every module's.
pub mod history_store;
// TxResBench: the frozen published models feature — the build-time-generated
// pretrained catalogue (cards + immutable release-asset pointers), served with
// a live → disk → embedded refresh, plus the download/sha256/cache/install
// actions into the model store and the per-model eligibility for the D list.
// DB-free; the module's only state is files under the app data root
// (`pretrained/`, `txr-pretrained/`, `pretrained-bundled/` — CONS-PC-10).
pub mod pretrained_catalogue;
pub mod health;
pub mod mcp;
// TxResBench: the app-owned method catalogue (embedded facts + eligibility /
// estimate engines + typed surfaces). DB-free, stateless, boot-validated embed.
pub mod method_catalogue;
pub mod rootfs;
pub mod sandbox;
// NOTE (artifact-model ITEM-13): the `tiledb_serve` module — the native in-process
// array reader (`ArraySource` trait + libtiledb FFI + the `NATIVE_ARRAY_BACKENDS`
// registry) — was DELETED along with its `tiledb_serve` Cargo feature and the
// `TXR_TILEDB_LIB` env var. INV-1: the server never opens a byte for meaning, so it
// links no format-parsing library at all. Artifact bytes are served as bytes
// (`GET /artifacts/{id}/data[/{*member}]`) and decoded in the browser.
pub mod jobs;
pub mod sync;

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use txresbench_framework::MODULE_ENTRIES;

    /// Every module's `order` must be UNIQUE across the whole linked set.
    ///
    /// `txresbench_framework::create_modules` sorts `MODULE_ENTRIES` with a *stable*
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
