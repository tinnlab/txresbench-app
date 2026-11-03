//! `file_validator` — the shared, stateless file layer (TxResBench).
//!
//! What the module owns (PROV-FV-1..8): the browser-decoded two-file contract
//! (screen C's patients + measurements tables and screen N's measurements-only
//! table — INV-3; byte decoding happens in the browser, DEC-1), the Rust
//! tidy-2.0 rule port over that canonical model (INV-8), the marker-vocabulary
//! matching with join offers and unit checks (DEC-10/12), the per-file inspect
//! and the full validate with per-patient coverage, the exact
//! [`method_catalogue`] inventory body (CONS-FV-2) and the canonical bundle rows
//! an execution engine writes as `/input` (PROV-FV-5), and the generated
//! template/example assets (PROV-FV-4, embedded at build time — INV-1).
//!
//! The module is STATELESS and DB-free (DEC-14/15): no database, no migration,
//! no events, no network I/O at run time (INV-5 — the only network use in the
//! app is env downloads and the update check, neither of this node). The join
//! mappings and file copies the user confirms live in the intake screen's state
//! and the run-history store, not here.
//!
//! The boot posture: the four CSV assets are validated once in [`init`]
//! (`assets::ensure_checked` — an empty or header-broken embed is a boot
//! refusal, the framework's `_checked` pattern; a missing embed is a BUILD
//! failure, since `include_bytes!` refuses to compile without the file).

pub mod assets;
pub mod bundle;
pub mod inspect;
pub mod routes;
pub mod rules;
pub mod types;
pub mod units;
pub mod validate;
pub mod vocab;

// The re-exported contract surface (PROV-FV-2/3/5): consumers bind the typed
// names directly; `types` stays the full surface for the submodule layering.
pub use assets::{AssetFacts, AssetsError, EmbeddedAssets, ASSETS};
pub use bundle::canonical_bundle;
pub use inspect::inspect;
pub use rules::{
    check_allowed_values, check_column_types, check_companion_features, check_day_range,
    check_exclusive_minimum, check_foreign_keys, check_join_equality, check_no_recognizable_header,
    check_null_iff, check_nullability, check_outcome_available, check_outcome_columns,
    check_paired_null, check_ranges, check_required_columns, check_single_time_unit,
    check_unique_keys, is_time_unit_column, normalize_header_name, required_roles,
    resolve_column_role, rule_declarations, validate_model, CanonicalModel, DerivedSample,
    FeatureRow, ModelCell, PatientRow, RuleApplicability, RuleDeclaration, RuleKind, TableShape,
    ValueRow, R20_DAY_MAX, R20_DAY_MIN, RULES,
};
pub use types::{
    AnalysisParameters, CanonCell, CanonicalBundle, CanonicalFeature, CanonicalPatient,
    CanonicalValue, ColumnRole, CovariateColumn, FileColumns, FileInspection,
    FileInspectionRequest, FileProblem, FileSummary, FileTableKind, JoinOffer, Limits,
    MarkerColumn, MarkerCoverage, MarkerMapping, MarkerMatch, MarkerSummary, MeasurementsSummary,
    ParsedTable, ParsedTableSource, PatientsSummary, ProblemCode, ProblemSeverity, TableFormat,
    UnitStatus, ValidationError, ValidationMode, ValidationRequest, ValidationResponse,
};
pub use types::{InventoryEligibilityRequest, UnitFamily};
pub use units::{
    compare_unit_to_canonical, infer_unit_family, marker_unit_facts, normalize_unit,
    unit_absent_problem, unit_mismatch_problem, unit_mixed_problem, unit_unclassified_problem,
    MarkerUnitFacts, UnitAgreement, UnitSpelling,
};
pub use validate::{patient_cohort, validate};
pub use vocab::{
    marker_matches, marker_matches_in, marker_matches_set, marker_spelling_groups,
    normalize_marker_name, MarkerMatchSet, MarkerSpelling,
};

use aide::axum::ApiRouter;
use linkme::distributed_slice;

use ziee_framework::{AppModule, ModuleContext, ModuleEntry, MODULE_ENTRIES};

/// The module instance (no state — the boot check's `OnceLock` is the only
/// runtime fact, installed by `init`).
pub struct FileValidatorModule;

impl AppModule for FileValidatorModule {
    fn name(&self) -> &'static str {
        "file_validator"
    }

    fn description(&self) -> &'static str {
        "Shared file layer: two-table inspection, tidy-2.0 validation, marker joins/units, per-patient coverage, canonical rows + template/example assets (TxResBench)."
    }

    fn init(&mut self, _ctx: &ModuleContext) -> Result<(), Box<dyn std::error::Error>> {
        // The boot check: the embedded template/example CSVs are validated ONCE
        // here. An error is the boxed named refusal (`AssetsError`) — module
        // init errors abort the boot, so a broken first-party asset is never
        // silently degraded into an empty template download.
        let facts = assets::ensure_checked().map_err(|e| {
            Box::<dyn std::error::Error>::from(format!(
                "file validator assets failed the boot check: {e}"
            ))
        })?;
        tracing::info!(
            patients_template_bytes = facts.patients_template.byte_len,
            measurements_template_bytes = facts.measurements_template.byte_len,
            patients_example_lines = facts.patients_example.line_count,
            measurements_example_lines = facts.measurements_example.line_count,
            "file validator assets loaded from the embedded files"
        );
        Ok(())
    }

    fn register_routes(&self, router: ApiRouter) -> ApiRouter {
        // The four endpoints (inspect, validate, the two template/example
        // asset getters) are layered on the typed contract in this module's
        // `routes` submodule — request/response only, no events (PROV-FV-8).
        router.merge(routes::file_validator_routes())
    }
}

/// Module registration. Distinct order (48) — see
/// `modules/mod.rs::module_order_is_unique`; 47 is `method_catalogue` (this
/// node's provider, earlier in the topological order), 60 is `rootfs`.
#[distributed_slice(MODULE_ENTRIES)]
static FILE_VALIDATOR: ModuleEntry = ModuleEntry {
    name: "file_validator",
    order: 48,
    description: "Shared file validation + template/example assets (TxResBench).",
    constructor: || Box::new(FileValidatorModule),
};

// The PROV-FV-1 registration invariant, pinned HERE so the node owns its half
// of the check: `modules/mod.rs::module_order_is_unique` (the framework test)
// is red on a PRE-EXISTING order-4 tie (`health` + `localsession`) at the
// branch base, so the node's own acceptance is asserted locally and the
// framework tie stays an epic-level finding (recorded in DRIFT-1).
#[cfg(test)]
mod tests {
    use ziee_framework::MODULE_ENTRIES;

    /// TEST-FV-19 (node half): `file_validator` is registered under
    /// `MODULE_ENTRIES` exactly once, with the declared order 48, and no OTHER
    /// module occupies 48 — `order` uniqueness for THIS node. The framework
    /// test's global tie (health+localsession at 4) is not this node's.
    #[test]
    fn file_validator_registers_once_at_unique_order_48() {
        let me: Vec<_> = MODULE_ENTRIES
            .iter()
            .filter(|e| e.name == "file_validator")
            .collect();
        assert_eq!(
            me.len(),
            1,
            "exactly one file_validator registration: {me:?}"
        );
        assert_eq!(me[0].order, 48, "the declared integration order");

        let order48: Vec<_> = MODULE_ENTRIES
            .iter()
            .filter(|e| e.order == 48)
            .map(|e| e.name)
            .collect();
        assert_eq!(
            order48,
            vec!["file_validator"],
            "no other module at order 48"
        );

        // The module instance builds through the constructor (the boot path's
        // own API — a constructor won't change shape without failing here).
        let built = (me[0].constructor)();
        assert_eq!(built.name(), "file_validator");
    }

    /// The module carries the contract surface the consumers bind: the four
    /// endpoints' wire types (PROV-FV-2/3) and the boot-checked assets
    /// (PROV-FV-4/6) are nameable from one path (the engine's in-process seam
    /// binds `types`/`assets` directly; the re-exports pin the crate-level
    /// paths so a rename is a compile error here, not a runtime miss).
    #[test]
    fn the_module_contract_surface_is_exposed() {
        let req = super::types::FileInspectionRequest {
            kind: super::types::FileTableKind::Patients,
            table: super::types::ParsedTable {
                source: super::types::ParsedTableSource {
                    name: "patients.csv".to_string(),
                    format: super::types::TableFormat::Csv,
                },
                header_row: 1,
                columns: Vec::new(),
                rows: Vec::new(),
            },
        };
        assert_eq!(req.kind, super::types::FileTableKind::Patients);
        assert!(!super::assets::ASSETS.patients_template.is_empty());
        assert_eq!(
            super::assets::AssetsError::Empty { name: "x" }.code(),
            "FILE_VALIDATOR_ASSET_EMPTY"
        );
        // The inventory is the provider's exact type (CONS-FV-2: the same
        // struct the eligibility route deserializes — no app-side copy).
        let inv = super::types::InventoryEligibilityRequest {
            patients: 0,
            decision_day: 56.0,
            baseline_max_day: 0.0,
            markers: Vec::new(),
            covariates: Vec::new(),
            outcomes: None,
        };
        assert_eq!(inv.patients, 0);
        // The provider's unit family is the app's one vocabulary (no duplicate
        // declaration): nameable from the module path, and its wire spelling is
        // the family the eligibility engine matches on.
        assert_eq!(
            serde_json::to_value(super::types::UnitFamily::None).unwrap(),
            serde_json::json!("none")
        );
    }
}
