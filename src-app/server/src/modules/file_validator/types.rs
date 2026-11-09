//! The `file_validator` type contract — the serde + JsonSchema surface of every
//! request and response the module owns (PROV-FV-2 `inspect`, PROV-FV-3
//! `validate`, PROV-FV-5 `canonical_bundle`), plus the shared wire types the
//! browser decode library (PROV-FV-7) and the `method_catalogue` inventory
//! (CONS-FV-2) agree on.
//!
//! The contract is deliberately TYPED everywhere a domain fact exists: the
//! problem-code vocabulary (the tidy-2.0 rule ids + the app's own A-id set) is
//! a closed enum, so a code nobody modelled cannot be sent or met; the file
//! kind, format, mode, unit verdict and match kind are enums for the same
//! reason. Open strings remain only where the benchmark registry itself is
//! open (marker id systems, spellings, covariate names) — the closed/open split
//! mirrors `method_catalogue::types`, the sibling contract for this node's
//! provider seam.
//!
//! The `inventory` field of [`ValidationResponse`] is the provider's OWN type
//! (`method_catalogue::types::InventoryEligibilityRequest`, re-exported here):
//! this node constructs that exact body (CONS-FV-2) so the intake screens can
//! post it straight to `POST /api/methods/eligibility` — the file layer never
//! re-declares a provider contract.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub use crate::modules::method_catalogue::types::{InventoryEligibilityRequest, UnitFamily};

// ─────────────────────────────────────────────────────────────────────────────
// Named limits (DEC-9: the validator's own tunables are NAMED constants in one
// place — a later promotion to user settings is a rename, not a rewrite).
// ─────────────────────────────────────────────────────────────────────────────

/// The validator's named limits. All of them are per-analysis or per-request
/// facts, never operational tunables, so they are constants here (no settings
/// table, no migration — DEC-9).
pub struct Limits;

impl Limits {
    /// A fuzzy vocabulary suggestion needs a marker name at least this long
    /// (ITEM-4's fuzzy matcher, DEC-12: suggestions only, never auto-joined).
    pub const MIN_FUZZY_MATCH_LEN: usize = 4;

    /// A fuzzy vocabulary suggestion list is truncated at this many entries
    /// (A05 — a bounded suggestion list, not an unbounded one).
    pub const MAX_FUZZY_CANDIDATES: usize = 5;

    /// Fewer than this many patients with a primary outcome turns the tidy
    /// R14 outcome-availability rule into a WARNING (the app-adapted severity
    /// divergence — the benchmark's R14 is an error; PLAN ITEM-3, recorded).
    pub const R14_MIN_OUTCOME: u32 = 10;

    /// The browser decode library scans at most this many file rows downward
    /// for a header (title rows are a common clinical-export reality; DEC-6).
    /// The library mirrors this value; its spec pins the parity.
    pub const HEADER_SCAN_MAX_ROWS: u32 = 5;

    /// Above this many value rows the validator adds the A06 soft notice
    /// (a desktop review point, never a size cap — DEC-9).
    pub const A06_NOTICE_VALUE_ROWS: u64 = 1_000_000;
}

/// The default decision day (screen B's middle option; the UI always sends the
/// user's choice — DEC-9).
pub const DEFAULT_DECISION_DAY: f64 = 56.0;

/// The default baseline window end per the 2026-10-19 contract definition:
/// a draw is baseline when it is taken at or before day 0 (DEC-9).
pub const DEFAULT_BASELINE_MAX_DAY: f64 = 0.0;

// ─────────────────────────────────────────────────────────────────────────────
// Shared wire types — the decode-library ↔ server boundary (PROV-FV-2/7)
// ─────────────────────────────────────────────────────────────────────────────

/// The two user-file tables (screen C and screen N) — one parsed shape, both
/// screens, one validation pipeline (INV-3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum FileTableKind {
    Patients,
    Measurements,
}

/// The byte format the browser decoded (the server never interprets bytes —
/// DEC-1: parsing stays in the browser, rules stay in Rust).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum TableFormat {
    Csv,
    Excel,
}

/// The source facts of a decoded table (the file name the user chose and the
/// byte format it decoded from).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ParsedTableSource {
    pub name: String,
    pub format: TableFormat,
}

/// The browser-decoded table: raw cells only, no interpretation (DEC-1). This
/// is the wire type of every file the module sees — both the C screen's two
/// tables and the N screen's measurements table (INV-3).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ParsedTable {
    pub source: ParsedTableSource,
    /// The 1-based FILE row holding the column names (DEC-6): every problem
    /// this module reports carries a FILE row number, so "Row 14" on screen
    /// matches the user's spreadsheet.
    pub header_row: u32,
    /// The column names, in file order.
    pub columns: Vec<String>,
    /// Data rows only (the header row is excluded). Cells are raw text; an
    /// empty cell is `null`.
    pub rows: Vec<Vec<Option<String>>>,
}

/// The resolved-role vocabulary of a file's columns (DEC-5 aliases). Not a wire
/// type: the wire `FileColumns.resolved` map is keyed by [`ColumnRole::wire_key`]
/// strings — `patient_id`, `pfs_days`, … and `covariate:<name>` for covariates
/// — so the inventory carries the role set exactly as the plan names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ColumnRole {
    PatientId,
    PfsDays,
    PfsEvent,
    OsDays,
    OsEvent,
    Responder,
    ResponseDay,
    Day,
    Marker,
    Value,
    Unit,
    Covariate(String),
}

impl ColumnRole {
    /// The wire-map key of the role (`covariate:<name>` for covariates; the
    /// bare role id otherwise — PROV-FV-2's `{role: column_name}` map).
    pub fn wire_key(&self) -> String {
        match self {
            ColumnRole::Covariate(name) => format!("covariate:{name}"),
            role => role.static_key().to_string(),
        }
    }

    fn static_key(&self) -> &'static str {
        match self {
            ColumnRole::PatientId => "patient_id",
            ColumnRole::PfsDays => "pfs_days",
            ColumnRole::PfsEvent => "pfs_event",
            ColumnRole::OsDays => "os_days",
            ColumnRole::OsEvent => "os_event",
            ColumnRole::Responder => "responder",
            ColumnRole::ResponseDay => "response_day",
            ColumnRole::Day => "day",
            ColumnRole::Marker => "marker",
            ColumnRole::Value => "value",
            ColumnRole::Unit => "unit",
            ColumnRole::Covariate(_) => unreachable!("covariate roles carry a name"),
        }
    }

    /// Parse a wire-map key back into the role (the reading side of
    /// [`wire_key`]; `"covariate:age"` → `Covariate("age")`).
    pub fn from_wire_key(key: &str) -> Option<ColumnRole> {
        if let Some(name) = key.strip_prefix("covariate:") {
            return Some(ColumnRole::Covariate(name.to_string()));
        }
        Some(match key {
            "patient_id" => ColumnRole::PatientId,
            "pfs_days" => ColumnRole::PfsDays,
            "pfs_event" => ColumnRole::PfsEvent,
            "os_days" => ColumnRole::OsDays,
            "os_event" => ColumnRole::OsEvent,
            "responder" => ColumnRole::Responder,
            "response_day" => ColumnRole::ResponseDay,
            "day" => ColumnRole::Day,
            "marker" => ColumnRole::Marker,
            "value" => ColumnRole::Value,
            "unit" => ColumnRole::Unit,
            _ => return None,
        })
    }
}

/// One covariate column's numeric-ness fact (an inspect-time report: a
/// covariate known to a numeric rule is a usable covariate; a text column is
/// a covariate the engine cannot use as a number).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CovariateColumn {
    pub name: String,
    pub is_numeric: bool,
}

/// The column-resolution report of one file (PROV-FV-2's `columns`).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FileColumns {
    /// role wire-key (`patient_id`, `pfs_days`, … `covariate:<name>`) →
    /// column name, for every column that matched a rule alias (DEC-5).
    pub resolved: BTreeMap<String, String>,
    /// Columns known to no rule — reported, never rejected (DEC-5).
    pub unresolved: Vec<String>,
    /// The covariate columns with their numeric-ness (the model's covariate
    /// input fact: a non-numeric covariate column is not usable as one).
    pub covariate_columns: Vec<CovariateColumn>,
}

// ─────────────────────────────────────────────────────────────────────────────
// PROBLEMS (INV-2) — every problem carries a row, and the code vocabulary is
// closed: the tidy-2.0 rule ids plus the app's own ids.
// ─────────────────────────────────────────────────────────────────────────────

/// A problem code — one of the tidy-2.0 rule ids (R01–R21, INV-8: the app
/// applies the benchmark's rule semantics to user files) or an app-specific id
/// (A01–A07) for conditions the four-table benchmark schema has no word for
/// (header recognition, required columns, join offers, units, size notices).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
pub enum ProblemCode {
    #[serde(rename = "R01")]
    R01TablesPresent,
    #[serde(rename = "R02")]
    R02RequiredColumns,
    #[serde(rename = "R03")]
    R03ColumnTypes,
    #[serde(rename = "R04")]
    R04Nullability,
    #[serde(rename = "R05")]
    R05AllowedValues,
    #[serde(rename = "R06")]
    R06Ranges,
    #[serde(rename = "R07")]
    R07UniqueKeys,
    #[serde(rename = "R08")]
    R08ValuesPatientExists,
    #[serde(rename = "R09")]
    R09ValuesSampleExists,
    #[serde(rename = "R10")]
    R10FeatureDescribed,
    #[serde(rename = "R11")]
    R11DayAgreement,
    #[serde(rename = "R12")]
    R12SingleTimeUnit,
    #[serde(rename = "R13")]
    R13NondetectCompanions,
    #[serde(rename = "R14")]
    R14OutcomeAvailable,
    #[serde(rename = "R15")]
    R15SamplesPatientExists,
    #[serde(rename = "R16")]
    R16ValueSampleSamePatient,
    #[serde(rename = "R17")]
    R17UnknownDayIffNull,
    #[serde(rename = "R18")]
    R18EventHasTime,
    #[serde(rename = "R19")]
    R19OutcomeTimePositive,
    #[serde(rename = "R20")]
    R20DayRange,
    #[serde(rename = "R21")]
    R21PreviewConsistent,
    #[serde(rename = "A01")]
    A01NoRecognizableHeader,
    #[serde(rename = "A02")]
    A02RequiredColumnNotFound,
    #[serde(rename = "A03")]
    A03SpellingVariantGroup,
    #[serde(rename = "A04")]
    A04UnitDiffers,
    #[serde(rename = "A05")]
    A05VocabularyCandidatesTruncated,
    #[serde(rename = "A06")]
    A06LargeFileNotice,
    #[serde(rename = "A07")]
    A07UnitAbsent,
}

impl ProblemCode {
    /// The stable wire id.
    pub fn code(&self) -> &'static str {
        match self {
            ProblemCode::R01TablesPresent => "R01",
            ProblemCode::R02RequiredColumns => "R02",
            ProblemCode::R03ColumnTypes => "R03",
            ProblemCode::R04Nullability => "R04",
            ProblemCode::R05AllowedValues => "R05",
            ProblemCode::R06Ranges => "R06",
            ProblemCode::R07UniqueKeys => "R07",
            ProblemCode::R08ValuesPatientExists => "R08",
            ProblemCode::R09ValuesSampleExists => "R09",
            ProblemCode::R10FeatureDescribed => "R10",
            ProblemCode::R11DayAgreement => "R11",
            ProblemCode::R12SingleTimeUnit => "R12",
            ProblemCode::R13NondetectCompanions => "R13",
            ProblemCode::R14OutcomeAvailable => "R14",
            ProblemCode::R15SamplesPatientExists => "R15",
            ProblemCode::R16ValueSampleSamePatient => "R16",
            ProblemCode::R17UnknownDayIffNull => "R17",
            ProblemCode::R18EventHasTime => "R18",
            ProblemCode::R19OutcomeTimePositive => "R19",
            ProblemCode::R20DayRange => "R20",
            ProblemCode::R21PreviewConsistent => "R21",
            ProblemCode::A01NoRecognizableHeader => "A01",
            ProblemCode::A02RequiredColumnNotFound => "A02",
            ProblemCode::A03SpellingVariantGroup => "A03",
            ProblemCode::A04UnitDiffers => "A04",
            ProblemCode::A05VocabularyCandidatesTruncated => "A05",
            ProblemCode::A06LargeFileNotice => "A06",
            ProblemCode::A07UnitAbsent => "A07",
        }
    }

    /// Parse a tidy-rule id or an app id. Both the bare id (`"R02"`) and the
    /// benchmark's spelled rule id (`"R02_required_columns"`) are accepted —
    /// the rule port (ITEM-3) reads the spelled ids from the embedded
    /// `tidy-2.0.json` copy and maps them onto the closed `ProblemCode` set.
    pub fn from_id(id: &str) -> Option<ProblemCode> {
        let bare = id.split('_').next().unwrap_or(id);
        Some(match bare {
            "R01" => ProblemCode::R01TablesPresent,
            "R02" => ProblemCode::R02RequiredColumns,
            "R03" => ProblemCode::R03ColumnTypes,
            "R04" => ProblemCode::R04Nullability,
            "R05" => ProblemCode::R05AllowedValues,
            "R06" => ProblemCode::R06Ranges,
            "R07" => ProblemCode::R07UniqueKeys,
            "R08" => ProblemCode::R08ValuesPatientExists,
            "R09" => ProblemCode::R09ValuesSampleExists,
            "R10" => ProblemCode::R10FeatureDescribed,
            "R11" => ProblemCode::R11DayAgreement,
            "R12" => ProblemCode::R12SingleTimeUnit,
            "R13" => ProblemCode::R13NondetectCompanions,
            "R14" => ProblemCode::R14OutcomeAvailable,
            "R15" => ProblemCode::R15SamplesPatientExists,
            "R16" => ProblemCode::R16ValueSampleSamePatient,
            "R17" => ProblemCode::R17UnknownDayIffNull,
            "R18" => ProblemCode::R18EventHasTime,
            "R19" => ProblemCode::R19OutcomeTimePositive,
            "R20" => ProblemCode::R20DayRange,
            "R21" => ProblemCode::R21PreviewConsistent,
            "A01" => ProblemCode::A01NoRecognizableHeader,
            "A02" => ProblemCode::A02RequiredColumnNotFound,
            "A03" => ProblemCode::A03SpellingVariantGroup,
            "A04" => ProblemCode::A04UnitDiffers,
            "A05" => ProblemCode::A05VocabularyCandidatesTruncated,
            "A06" => ProblemCode::A06LargeFileNotice,
            "A07" => ProblemCode::A07UnitAbsent,
            _ => return None,
        })
    }

    /// The complete closed code vocabulary, in id order (the registry test's
    /// pin — ITEM-3 asserts every tidy rule id maps here, so a rule the port
    /// cannot name is a compile-exposed gap, never a silent skip).
    pub const ALL: [ProblemCode; 28] = [
        ProblemCode::R01TablesPresent,
        ProblemCode::R02RequiredColumns,
        ProblemCode::R03ColumnTypes,
        ProblemCode::R04Nullability,
        ProblemCode::R05AllowedValues,
        ProblemCode::R06Ranges,
        ProblemCode::R07UniqueKeys,
        ProblemCode::R08ValuesPatientExists,
        ProblemCode::R09ValuesSampleExists,
        ProblemCode::R10FeatureDescribed,
        ProblemCode::R11DayAgreement,
        ProblemCode::R12SingleTimeUnit,
        ProblemCode::R13NondetectCompanions,
        ProblemCode::R14OutcomeAvailable,
        ProblemCode::R15SamplesPatientExists,
        ProblemCode::R16ValueSampleSamePatient,
        ProblemCode::R17UnknownDayIffNull,
        ProblemCode::R18EventHasTime,
        ProblemCode::R19OutcomeTimePositive,
        ProblemCode::R20DayRange,
        ProblemCode::R21PreviewConsistent,
        ProblemCode::A01NoRecognizableHeader,
        ProblemCode::A02RequiredColumnNotFound,
        ProblemCode::A03SpellingVariantGroup,
        ProblemCode::A04UnitDiffers,
        ProblemCode::A05VocabularyCandidatesTruncated,
        ProblemCode::A06LargeFileNotice,
        ProblemCode::A07UnitAbsent,
    ];
}

/// The severity of a problem (the benchmark's own split: errors block,
/// warnings are reported — INV-8).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProblemSeverity {
    Error,
    Warning,
}

/// One reported problem (INV-2: every problem carries its FILE row — 1-based,
/// header included — or `null` for file-level; columns are named when the
/// problem is a column's, `null` otherwise).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FileProblem {
    pub code: ProblemCode,
    pub severity: ProblemSeverity,
    pub row: Option<u32>,
    pub column: Option<String>,
    pub message: String,
}

impl FileProblem {
    pub fn new(
        code: ProblemCode,
        severity: ProblemSeverity,
        row: Option<u32>,
        column: Option<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            code,
            severity,
            row,
            column,
            message: message.into(),
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-FV-2 — POST /api/file-validation/inspect
// ─────────────────────────────────────────────────────────────────────────────

/// The inspect request body: ONE file, no cross-file context (screen C inspects
/// each file as it is dropped; screen N inspects its only file — INV-3).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FileInspectionRequest {
    pub kind: FileTableKind,
    pub table: ParsedTable,
}

/// One marker column's inspect summary (name → value-row count).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct MarkerSummary {
    pub name: String,
    pub rows: u32,
}

/// The file-level summary facts of an inspect call (row count, marker columns
/// and their row counts, the distinct draw days).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FileSummary {
    pub rows: u32,
    pub markers: Vec<MarkerSummary>,
    pub draw_days: Vec<f64>,
}

/// The inspect response (PROV-FV-2). The problems cover the per-file checks
/// (types, nullability, uniqueness, cross-table references that are
/// resolvable single-file, header and required-column problems); the full
/// cross-table + join + units + outcome set is the `validate` response's.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FileInspection {
    pub kind: FileTableKind,
    pub source_name: String,
    pub columns: FileColumns,
    pub problems: Vec<FileProblem>,
    pub summary: FileSummary,
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-FV-3 — POST /api/file-validation/validate
// ─────────────────────────────────────────────────────────────────────────────

/// The analysis mode: `files` (the complete two-table file set — the C screen)
/// or `predict` (measurements only — the N screen, INV-3: the same endpoints
/// serve both).
///
/// Wire spelling: the frozen plan (PROV-FV-3) names this value with the
/// one word the framework's rename-completeness scan (`scripts/check-no-*
/// -domain-literals.sh`) bans across `src-app/**` — the plan's own invariants
/// (INV-7, TEST-FV-15) require the shipped module to carry ZERO such tokens.
/// The wire spelling here uses the app's own word for the C screen
/// (`Files.dc.html` "your files"; the `/files` route of the flow) — the
/// two-mode split, the 400 mapping and every test intent are unchanged
/// (DRIFT-1 ITEM-2 #1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ValidationMode {
    Files,
    Predict,
}

/// The analysis parameters: the decision day and the baseline window end
/// (2026-10-19 contract: a draw is baseline when day ≤ `baseline_max_day`;
/// pre-treatment negative days count as baseline). Per-analysis user inputs
/// (screen B/C), never operational tunables (DEC-9); defaults apply when the
/// UI omits the block.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct AnalysisParameters {
    #[serde(default = "default_decision_day")]
    pub decision_day: f64,
    #[serde(default = "default_baseline_max_day")]
    pub baseline_max_day: f64,
}

impl Default for AnalysisParameters {
    fn default() -> Self {
        Self {
            decision_day: DEFAULT_DECISION_DAY,
            baseline_max_day: DEFAULT_BASELINE_MAX_DAY,
        }
    }
}

fn default_decision_day() -> f64 {
    DEFAULT_DECISION_DAY
}

fn default_baseline_max_day() -> f64 {
    DEFAULT_BASELINE_MAX_DAY
}

/// A join offer the user accepted: every `variants` spelling of one logical
/// marker column merges into the single `key` (DEC-12: nothing is ever
/// auto-applied — an `A03` problem is a QUESTION; the user's `joins[]` entry
/// is the answer).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct JoinOffer {
    pub variants: Vec<String>,
    pub key: String,
}

/// A vocabulary mapping the user confirmed: file column `key` is the
/// vocabulary marker `marker_id` (DEC-12: mapping is explicit only; fuzzy
/// suggestions are never applied without it).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct MarkerMapping {
    pub key: String,
    pub marker_id: String,
}

/// The validate request body (PROV-FV-3): both tables (or only measurements in
/// predict mode), the accepted joins, the confirmed vocabulary mappings and the
/// analysis parameters.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ValidationRequest {
    pub mode: ValidationMode,
    pub patients: Option<ParsedTable>,
    pub measurements: ParsedTable,
    #[serde(default)]
    pub joins: Vec<JoinOffer>,
    #[serde(default)]
    pub mapping: Vec<MarkerMapping>,
    #[serde(default)]
    pub parameters: AnalysisParameters,
}

/// The matched item kind (DEC-12 match ladder: exact display name → alias →
/// standard id → fuzzy containment suggestion, in that order; fuzzy is a
/// suggestion only).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MatchKind {
    Exact,
    Alias,
    StandardId,
    Fuzzy,
}

/// One vocabulary candidate for a file marker column (the join offer's
/// "this column looks like X" fact — PROV-FV-3's `MarkerMatch`).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct MarkerMatch {
    /// The vocabulary marker's id within its system.
    pub marker_id: String,
    /// The raw registry system spelling (`LOINC`, `HGNC`, … — the open-string
    /// system, same as `StandardId.system`, never a closed list here).
    pub system: String,
    pub display_name: String,
    pub unit_family: UnitFamily,
    pub canonical_unit: String,
    /// How many runnable methods reference this marker (the join-offer
    /// weight — a marker 300 methods rank differently from one 3 do).
    pub n_methods: u32,
    pub match_kind: MatchKind,
}

/// The per-marker coverage counts (EXAMPLE-FV-3: the board's "needs 3 or more
/// draws; 120 of 151 have them" is renderable from these three numbers).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
pub struct MarkerCoverage {
    pub patients_with_value: u32,
    pub patients_with_baseline: u32,
    pub patients_with_ontreatment: u32,
}

/// The unit verdict of one marker column (DEC-10: `matches` against the
/// vocabulary's `canonical_unit`, `family` when only the family agrees, an
/// honest `unknown` when nothing is known, `absent` when the file carries no
/// unit, `mixed` when the column is not constant).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum UnitStatus {
    Matches,
    Family,
    Unknown,
    Absent,
    Mixed,
}

/// One resolved marker column of the file (after joins and mappings) — the
/// per-marker facts the C/N card renders and the inventory is built from.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct MarkerColumn {
    /// The stable column key (the join key after merges).
    pub key: String,
    /// Every spelling that merged into this key (`["ldh", "LDH"]` after a
    /// join — EXAMPLE-FV-1).
    pub spellings: Vec<String>,
    pub n_rows: u32,
    pub unit: Option<String>,
    pub unit_status: UnitStatus,
    /// The vocabulary candidates (join offers) — suggestions, never applied.
    pub vocabulary: Vec<MarkerMatch>,
    pub coverage: MarkerCoverage,
}

/// The patients-table summary facts of a validate call.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PatientsSummary {
    pub rows: u32,
    /// Patients with a resolvable primary outcome (pfs or os event+time, or a
    /// responder+response_day pair) — the R14-availability fact.
    pub with_primary_outcome: u32,
    /// Patients whose PRIMARY outcome indicator is 1 (pfs_event/os_event = 1,
    /// responder = 1) on the same pfs → os → responder ladder
    /// [`primary_outcome`](super::validate::primary_outcome) uses — the
    /// board's "N progressions or deaths" fact: EVENTS, not patients with an
    /// outcome (qa-fixes ITEM-6, F1; the old display read
    /// `with_primary_outcome` and reported "94 progressions or deaths" for a
    /// file with 82 events).
    pub primary_outcome_events: u32,
    /// Median follow-up (the event time of the primary outcome, in days);
    /// `null` when no outcome is resolvable.
    pub median_followup_days: Option<f64>,
}

/// The measurements-table summary facts of a validate call.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct MeasurementsSummary {
    pub rows: u32,
    /// Distinct patients in the measurements table (the predict-mode
    /// cohort — TEST-FV-9).
    pub patients: u32,
    /// The distinct draw days, ascending (the "draw times" the engine and the
    /// screen B schedule need).
    pub distinct_draw_days: Vec<f64>,
}

/// The validate response (PROV-FV-3): the FULL problem set (per-file +
/// cross-table + units + joins + outcome availability), the resolved marker
/// columns, both table summaries and the inventory body — the EXACT body of
/// `POST /api/methods/eligibility` (CONS-FV-2: the engine replays it
/// in-process, so the type is the provider's own).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ValidationResponse {
    pub problems: Vec<FileProblem>,
    pub markers: Vec<MarkerColumn>,
    pub patients: Option<PatientsSummary>,
    pub measurements: MeasurementsSummary,
    pub inventory: InventoryEligibilityRequest,
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-FV-5 — the in-process canonical bundle (the engine's `/input` seam)
// ─────────────────────────────────────────────────────────────────────────────

/// One covariate cell: a number, or text (the tidy covariate rule: a column is
/// float64 when every non-null value is numeric, else string — one type per
/// column). The engine writes it verbatim into `covariates.csv`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum CanonCell {
    Number(f64),
    Text(String),
}

/// One patient row of the canonical bundle — the four outcome column kinds and
/// the covariates, exactly the facts `outcomes.csv` and `covariates.csv` carry
/// (contract.md's fixed column set; the engine owns outcome derivation for the
/// chosen task).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CanonicalPatient {
    pub patient_id: String,
    pub pfs_days: Option<f64>,
    pub pfs_event: Option<i64>,
    pub os_days: Option<f64>,
    pub os_event: Option<i64>,
    pub responder: Option<i64>,
    pub response_day: Option<f64>,
    pub covariates: Vec<(String, CanonCell)>,
}

/// One measurement row of the canonical bundle — a `long.csv` row
/// (`patient_id, day, feature, value`; the unit travels beside the value so
/// the engine's unit check is the check the file layer made).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CanonicalValue {
    pub patient_id: String,
    pub day: f64,
    pub feature: String,
    pub value: Option<f64>,
    pub unit: Option<String>,
}

/// One feature fact of the canonical bundle — the per-marker metadata the
/// engine's feature list needs (the tidy `features` table folded into marker
/// metadata, DEC-4): the joined spelling, the vocabulary id when mapped, and
/// the companion flag (a `__detected`/`__lod` column never ranks or matches —
/// R13 semantics).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CanonicalFeature {
    pub feature: String,
    pub unit: Option<String>,
    pub marker_id: Option<String>,
    pub is_detection_companion: bool,
}

/// The canonical bundle (PROV-FV-5): patients + values + features, in the
/// fixed column set the engine writes as `/input`'s `long.csv` / `outcomes.csv`
/// / `covariates.csv`. ALL draws are kept — landmark cutting is the engine's.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CanonicalBundle {
    pub patients: Vec<CanonicalPatient>,
    pub values: Vec<CanonicalValue>,
    pub features: Vec<CanonicalFeature>,
}

// ─────────────────────────────────────────────────────────────────────────────
// In-process error (the PROV-FV-5 seam's `Result` error)
// ─────────────────────────────────────────────────────────────────────────────

/// The validate/bundle error vocabulary. The codes are the plan's 400 codes
/// (INVALID_MODE and INVALID_KIND are request-PARSE errors — the routes map
/// the typed-enum parse failure onto them; MISSING_PATIENTS and INVALID_JOIN
/// are ENGINE errors and are the variants here).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValidationError {
    /// The `files` mode (the C-screen full set) without a patients table.
    MissingPatients,
    /// A join variant or a mapping key that is not a measurement marker key
    /// (the 400 INVALID_JOIN condition — TEST-FV-10/FV-21).
    InvalidJoin { key: String },
}

impl ValidationError {
    /// The stable machine code.
    pub fn code(&self) -> &'static str {
        match self {
            ValidationError::MissingPatients => "MISSING_PATIENTS",
            ValidationError::InvalidJoin { .. } => "INVALID_JOIN",
        }
    }
}

impl std::fmt::Display for ValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ValidationError::MissingPatients => {
                write!(f, "MISSING_PATIENTS: the files mode needs a patients table")
            }
            ValidationError::InvalidJoin { key } => write!(
                f,
                "INVALID_JOIN: `{key}` is not a measurement marker column key"
            ),
        }
    }
}

impl std::error::Error for ValidationError {}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — the contract pins (the wire spelling of every closed vocabulary +
// the serde defaults; the acceptance TESTS build on these).
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn problem_codes_serialize_to_the_plan_ids() {
        // The plan's code set, pinned as an exact string list the UI switches
        // on (INV-2: codes matter, messages do not).
        let ids: Vec<&str> = ProblemCode::ALL.iter().map(|c| c.code()).collect();
        assert_eq!(
            ids,
            vec![
                "R01", "R02", "R03", "R04", "R05", "R06", "R07", "R08", "R09", "R10", "R11", "R12",
                "R13", "R14", "R15", "R16", "R17", "R18", "R19", "R20", "R21", "A01", "A02", "A03",
                "A04", "A05", "A06", "A07",
            ]
        );
        // Serde emits the same id (the enum rename arms).
        assert_eq!(
            serde_json::to_value(ProblemCode::R03ColumnTypes).unwrap(),
            json!("R03")
        );
        assert_eq!(
            serde_json::to_value(ProblemCode::A04UnitDiffers).unwrap(),
            json!("A04")
        );
    }

    #[test]
    fn problem_code_parses_bare_and_spelled_rule_ids() {
        assert_eq!(
            ProblemCode::from_id("R02"),
            Some(ProblemCode::R02RequiredColumns)
        );
        assert_eq!(
            ProblemCode::from_id("R02_required_columns"),
            Some(ProblemCode::R02RequiredColumns)
        );
        assert_eq!(
            ProblemCode::from_id("A07"),
            Some(ProblemCode::A07UnitAbsent)
        );
        assert_eq!(ProblemCode::from_id("R99"), None);
        assert_eq!(ProblemCode::from_id("not-a-code"), None);
        // Every tidy rule id R01..R21 maps (the ITEM-3 registry's completeness
        // anchor: an unmapped id is a compile-exposed gap here, before the
        // port even exists).
        for n in 1..=21 {
            let id = format!("R{n:02}");
            assert!(
                ProblemCode::from_id(&id).is_some(),
                "tidy rule id {id} must map into ProblemCode"
            );
        }
    }

    #[test]
    fn problem_serializes_null_row_and_column_as_null() {
        let p = FileProblem::new(
            ProblemCode::R03ColumnTypes,
            ProblemSeverity::Error,
            None,
            None,
            "message",
        );
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(
            v,
            json!({
                "code": "R03",
                "severity": "error",
                "row": null,
                "column": null,
                "message": "message",
            })
        );
        let with_row = FileProblem::new(
            ProblemCode::R03ColumnTypes,
            ProblemSeverity::Error,
            Some(14),
            Some("day".to_string()),
            "day is 'week 4'",
        );
        let v = serde_json::to_value(with_row).unwrap();
        assert_eq!(v["row"], json!(14));
        assert_eq!(v["column"], json!("day"));
    }

    #[test]
    fn parsed_table_roundtrips_with_null_cells() {
        let table = ParsedTable {
            source: ParsedTableSource {
                name: "measurements.csv".to_string(),
                format: TableFormat::Csv,
            },
            header_row: 1,
            columns: vec!["patient_id".to_string(), "day".to_string()],
            rows: vec![vec![Some("P1".to_string()), None]],
        };
        let v = serde_json::to_value(&table).unwrap();
        assert_eq!(v["source"]["format"], json!("csv"));
        assert_eq!(v["rows"][0][1], Value::Null);
        let back: ParsedTable = serde_json::from_value(v).unwrap();
        assert_eq!(back.rows[0][0].as_deref(), Some("P1"));
        assert_eq!(back.rows[0][1], None);
    }

    #[test]
    fn unknown_kind_and_mode_are_parse_errors() {
        // The typed enums make an unknown kind/mode a deserialization error —
        // the routes' 400 INVALID_KIND / INVALID_MODE mapping.
        let bad_kind = json!({"kind": "tables", "table": {}});
        assert!(serde_json::from_value::<FileInspectionRequest>(bad_kind).is_err());
        let bad_mode = json!({"mode": "batch", "measurements": {}});
        assert!(serde_json::from_value::<ValidationRequest>(bad_mode).is_err());
        // And the valid spellings parse.
        assert_eq!(
            serde_json::from_value::<FileTableKind>(json!("patients")).unwrap(),
            FileTableKind::Patients
        );
        assert_eq!(
            serde_json::from_value::<ValidationMode>(json!("predict")).unwrap(),
            ValidationMode::Predict
        );
    }

    #[test]
    fn validation_request_applies_the_parameter_defaults() {
        let req: ValidationRequest = serde_json::from_value(json!({
            "mode": "files",
            "measurements": {"source": {"name": "m.csv", "format": "csv"}, "header_row": 1,
                              "columns": ["patient_id"], "rows": []},
        }))
        .unwrap();
        assert_eq!(req.parameters.decision_day, DEFAULT_DECISION_DAY);
        assert_eq!(req.parameters.baseline_max_day, DEFAULT_BASELINE_MAX_DAY);
        // Explicit values win.
        let req: ValidationRequest = serde_json::from_value(json!({
            "mode": "files",
            "measurements": {"source": {"name": "m.csv", "format": "csv"}, "header_row": 1,
                              "columns": ["patient_id"], "rows": []},
            "parameters": {"decision_day": 28.0, "baseline_max_day": -30.0},
        }))
        .unwrap();
        assert_eq!(req.parameters.decision_day, 28.0);
        assert_eq!(req.parameters.baseline_max_day, -30.0);
    }

    #[test]
    fn wire_spellings_of_unit_status_and_match_kind() {
        for (verdict, expect) in [
            (UnitStatus::Matches, "matches"),
            (UnitStatus::Family, "family"),
            (UnitStatus::Unknown, "unknown"),
            (UnitStatus::Absent, "absent"),
            (UnitStatus::Mixed, "mixed"),
        ] {
            assert_eq!(serde_json::to_value(verdict).unwrap(), json!(expect));
        }
        for (kind, expect) in [
            (MatchKind::Exact, "exact"),
            (MatchKind::Alias, "alias"),
            (MatchKind::StandardId, "standard_id"),
            (MatchKind::Fuzzy, "fuzzy"),
        ] {
            assert_eq!(serde_json::to_value(kind).unwrap(), json!(expect));
        }
        // The unit family vocabulary is the provider's own enum (PROV-MC-4):
        // the same seven families, no app-side duplicate declaration.
        assert_eq!(
            serde_json::to_value(UnitFamily::ConcentrationMass).unwrap(),
            json!("concentration_mass")
        );
    }

    #[test]
    fn column_role_wire_keys_roundtrip() {
        for role in [
            ColumnRole::PatientId,
            ColumnRole::Day,
            ColumnRole::Marker,
            ColumnRole::Unit,
        ] {
            let key = role.wire_key();
            assert_eq!(ColumnRole::from_wire_key(&key), Some(role.clone()));
        }
        let cov = ColumnRole::Covariate("age".to_string());
        assert_eq!(cov.wire_key(), "covariate:age");
        assert_eq!(
            ColumnRole::from_wire_key("covariate:age"),
            Some(ColumnRole::Covariate("age".to_string()))
        );
        assert_eq!(ColumnRole::from_wire_key("age"), None);
    }

    #[test]
    fn canonical_cells_are_untagged_number_or_text() {
        let cell: CanonCell = serde_json::from_value(json!(47.0)).unwrap();
        assert_eq!(cell, CanonCell::Number(47.0));
        let cell: CanonCell = serde_json::from_value(json!("F")).unwrap();
        assert_eq!(cell, CanonCell::Text("F".to_string()));
    }

    #[test]
    fn validation_error_codes_are_the_plan_400_codes() {
        assert_eq!(ValidationError::MissingPatients.code(), "MISSING_PATIENTS");
        assert_eq!(
            ValidationError::InvalidJoin { key: "x".into() }.code(),
            "INVALID_JOIN"
        );
        assert!(!ValidationError::MissingPatients.to_string().is_empty());
    }
}
