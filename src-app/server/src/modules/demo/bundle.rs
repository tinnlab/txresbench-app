//! The demo bundle (demo-mode ITEM-2): the recorded results the demo replays.
//!
//! ## What the bundle is
//!
//! A directory (generated, never committed — it lives in the deployment's
//! data directory) produced by a REAL desktop-mode run on the example data:
//!
//! ```text
//! <bundle dir>/
//!   manifest.json                  — versioned JSON: the whole record
//!   train/<config-id>/<method>.csv — one method's per-patient predictions
//!   reuse/<config-id>/<method>.csv — the same method's reuse-run predictions
//! ```
//!
//! For each (dataset, configuration, method) the manifest records the train
//! run's per-patient prediction column (label/task/prob-source/coverage +
//! the table reference), the measured run seconds, the saved model's
//! metadata, the reuse run's prediction column, and — per configuration —
//! the recorded log lines. NO CODE is carried: the demo replays recorded
//! numbers; it never executes a method.
//!
//! ## The canonical table hash
//!
//! The manifest's `tables.*.content_hash` is the sha256 of a CANONICAL text
//! form of the table's logical content (columns + data rows), so the recorder
//! (Python) and the server (Rust) compute identical hashes over the same
//! parsed table no matter how the CSV text was split:
//!
//! 1. each row is padded with empty fields to the column count, then trailing
//!    empty fields are dropped (a CSV reader may or may not keep them);
//! 2. a field that is `null` or `""` encodes as an empty string; every other
//!    field is verbatim (whitespace is significant — it is the data);
//! 3. a field containing `,` `"` or a line break is quoted RFC4180-style
//!    (`"` doubled inside);
//! 4. the header line and the rows are joined with `\n`, no trailing newline;
//! 5. the hash is `"sha256:" + lowercase hex`.
//!
//! The pinned test vector (`canonical_hash_matches_the_recorder_vector`) is
//! the cross-language lockstep: the Python recorder's unit test pins the same
//! text and hash.
//!
//! ## Boot validation (the loader)
//!
//! Demo mode is a deliberate deployment choice, so a missing or invalid
//! bundle is a BOOT REFUSAL — never a silent "demo without data" — with a
//! message naming the path and the recorder. The loader checks: the manifest
//! parses into the version-1 schema; the example table hashes equal the ones
//! the recorder computed over the SAME embedded example bytes (a generator
//! change after recording invalidates the bundle loudly — the demo must
//! never replay predictions recorded for other data); every referenced table
//! file exists inside the bundle dir and parses with the engine's CSV codec
//! with the recorded row count; every record names a recorded configuration;
//! and a reuse record never exists without its model record.
//!
//! ## The inspect/validate example-hash guard
//!
//! In demo mode the two file-validation routes accept ONLY the example
//! tables: the request table's canonical hash must equal the bundle's
//! recorded hash (at boot proven equal to the embedded example bytes).
//! `inspect` accepts the table named by its kind (the predict screen inspects
//! its one file AS kind `measurements`, so that kind admits both the training
//! measurements table and the predict-measurements table); `validate` in
//! `files` mode requires the training pair, in `predict` mode the
//! predict-measurements table. Anything else is `403 DEMO_MODE`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::config;
use crate::modules::execution_engine::bundle::{CsvTable, parse_csv};
use crate::modules::execution_engine::types::{TxrCoverage, TxrEndpoint, TxrProbSource, TxrTask};
use crate::modules::file_validator::types::ParsedTable;

/// The manifest's format-tag value (the parser refuses anything else — a
/// bundle can never be mistaken for another JSON file).
pub const FORMAT_TAG: &str = "txresbench-demo-bundle";

/// The bundle format version (schema + semantics). The loader accepts
/// exactly this version; a recorder that changes the format bumps it and an
/// old loader refuses with a clear error instead of mis-reading.
pub const FORMAT_VERSION: u32 = 1;

/// The env var pointing at the bundle (ITEM-2: `$TXR_DEMO_BUNDLE`).
pub const BUNDLE_ENV: &str = "TXR_DEMO_BUNDLE";

/// The default bundle directory name inside the app data dir.
pub const DEFAULT_BUNDLE_DIR_NAME: &str = "demo-bundle";

/// The manifest file name inside the bundle dir.
pub const MANIFEST_FILE: &str = "manifest.json";

// ─────────────────────────────────────────────────────────────────────────────
// The manifest schema (version 1)
// ─────────────────────────────────────────────────────────────────────────────

/// The whole manifest (`manifest.json`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DemoBundle {
    /// Exactly [`FORMAT_TAG`].
    pub format: String,
    /// Exactly [`FORMAT_VERSION`].
    pub version: u32,
    /// When the recorder wrote the bundle (UTC).
    pub generated_at: DateTime<Utc>,
    /// The dataset id the records were recorded on (the example family:
    /// `"example"`).
    pub dataset_id: String,
    pub tables: BundleTables,
    pub configurations: Vec<BundleConfiguration>,
    pub methods: Vec<BundleMethod>,
}

/// The example tables' recorded content hashes (the guard's reference).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundleTables {
    pub patients: BundleTable,
    pub measurements: BundleTable,
    pub predict_measurements: BundleTable,
}

/// One example table's recorded facts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundleTable {
    /// `"sha256:" + hex`, over the canonical text form of the table.
    pub content_hash: String,
    /// The data-row count (the loader re-checks the embedded asset).
    pub rows: u64,
    /// The column names, in order (the loader re-checks the embedded asset).
    pub columns: Vec<String>,
}

/// One recorded analysis configuration (the E screen's choices).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundleConfiguration {
    /// The stable record key (the recorder's deterministic grammar; the
    /// directory name of the config's tables).
    pub id: String,
    pub endpoint: TxrEndpoint,
    pub decision_day: f64,
    pub look_ahead_day: f64,
    pub covariates: bool,
    /// The train run's recorded log lines, in sequence, each tagged with the
    /// method it belongs to (the engine's `engine` lines carry none).
    #[serde(default)]
    pub logs: Vec<BundleLogLine>,
}

/// One recorded log line (stream + content; sequence and timestamps are
/// re-derived by the replay — ITEM-3).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundleLogLine {
    pub method_id: Option<String>,
    /// `"stdout"` | `"stderr"` | `"engine"` (the log stream vocabulary).
    pub stream: String,
    pub content: String,
}

/// One recorded method's records (one per configuration the method ran).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundleMethod {
    /// The catalogue method id (the run's `method_id`).
    pub method_id: String,
    pub records: Vec<BundleMethodRecord>,
}

/// One (method, configuration) record: the train run's column + the measured
/// seconds + the saved model's metadata + the reuse run's column.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundleMethodRecord {
    /// Must name a [`BundleConfiguration`] id.
    pub configuration_id: String,
    /// The measured run seconds of the method (the run's own per-method
    /// elapsed — the replay's duration / `replay_speed` source).
    pub seconds: f64,
    pub train: BundlePredictionsColumn,
    /// The saved model's metadata (`None` for a method whose run produced no
    /// model tree — it is still recorded, but the model-backed paths do not
    /// offer it).
    #[serde(default)]
    pub model: Option<BundleModel>,
    /// The reuse run's column on the example predict file. `None` when there
    /// is no model record (a reuse run is impossible without one).
    #[serde(default)]
    pub reuse: Option<BundlePredictionsColumn>,
}

/// One method's per-patient prediction column (train or reuse).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundlePredictionsColumn {
    /// The table path relative to the bundle dir
    /// (`train/<config-id>/<method-id>.csv` etc.).
    pub table: String,
    pub label: String,
    pub group: String,
    pub group_label: String,
    pub task: TxrTask,
    pub prob_source: TxrProbSource,
    #[serde(default)]
    pub flat_conversion: bool,
    pub coverage: TxrCoverage,
    /// The data rows the table must carry (the run's ordered patient list).
    pub rows: u64,
}

/// The saved model's recorded metadata (the demo's model rows point at it —
/// ITEM-3; the number fields are the recorded ones, never recomputed).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundleModel {
    /// The display name (the run's label — the reuse column's label source).
    pub name: String,
    pub method_version: String,
    pub group: String,
    pub group_label: String,
    pub task: Option<TxrTask>,
    pub trained_on_patients: Option<u32>,
    pub trained_at: Option<DateTime<Utc>>,
    pub decision_day: f64,
    pub endpoint: TxrEndpoint,
    pub horizon: f64,
    pub size_bytes: u64,
    pub embeds_training_data: bool,
    pub own_auc: Option<f64>,
    pub marker_count: Option<u32>,
    /// The marker kind spelling (`any`/`all`/… — the catalogue's vocabulary).
    pub marker_kind: Option<String>,
    pub uses_covariates: bool,
}

// ─────────────────────────────────────────────────────────────────────────────
// The canonical content hash
// ─────────────────────────────────────────────────────────────────────────────

/// Whether a field must be quoted in the canonical text form (RFC4180
/// minimal: a comma, a quote, or a line break in the field).
fn field_needs_quoting(field: &str) -> bool {
    field.contains(',') || field.contains('"') || field.contains('\n') || field.contains('\r')
}

/// One canonical CSV field (or the header/row line's field) — the single
/// encoder both directions of the bundle use.
fn append_field(out: &mut String, field: &str) {
    if field_needs_quoting(field) {
        out.push('"');
        out.push_str(&field.replace('"', "\"\""));
        out.push('"');
    } else {
        out.push_str(field);
    }
}

/// Append one canonical CSV line (the header, or one normalized data row).
/// `values` is the row (already padded to `n` by the caller's own rule for
/// the header — data rows are normalized here: pad to `n`, then drop
/// trailing empty fields so a reader that trims them and one that keeps them
/// agree on the same canonical text).
fn append_line(out: &mut String, values: &[&str], pad_to: usize, trim_trailing: bool) {
    let mut all: Vec<&str> = values.iter().map(|c| *c).collect();
    if all.len() < pad_to {
        all.resize(pad_to, "");
    }
    if trim_trailing {
        while all.last().is_some_and(|c| c.is_empty()) {
            all.pop();
        }
    }
    for (i, field) in all.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        append_field(out, field);
    }
}

/// The canonical text form of a table's logical content (see the module
/// doc's rules 1–4). `None` and `Some("")` fields are the same content (the
/// CSV reader's empty field), so they encode identically.
pub fn canonical_table_text(columns: &[String], rows: &[Vec<Option<String>>]) -> String {
    let mut out = String::new();
    append_line(&mut out, &columns.iter().map(|c| c.as_str()).collect::<Vec<_>>(), 0, false);
    for row in rows {
        let values: Vec<&str> = row.iter().map(|c| c.as_deref().unwrap_or("")).collect();
        out.push('\n');
        append_line(&mut out, &values, columns.len(), true);
    }
    out
}

/// The canonical content hash (`"sha256:" + hex`) of a table's logical
/// content — the ONE hash the recorder, the loader and the demo guard agree
/// on (rules 1–5 above).
pub fn canonical_table_hash(columns: &[String], rows: &[Vec<Option<String>>]) -> String {
    let text = canonical_table_text(columns, rows);
    format!("sha256:{}", hex::encode(Sha256::digest(text.as_bytes())))
}

/// The canonical hash of a parsed table (the request/asset shape).
pub fn parsed_table_hash(table: &ParsedTable) -> String {
    canonical_table_hash(&table.columns, &table.rows)
}

/// The canonical hash of an embedded CSV asset: the asset is parsed with the
/// module's own minimal CSV split (the example assets are unquoted —
/// verified by the file-validator material check), then hashed like any
/// other table. This is the function the recorder's Python twin replicates
/// over the same bytes.
pub fn csv_bytes_content_hash(bytes: &[u8]) -> String {
    let (columns, rows) = parse_asset_csv(bytes);
    canonical_table_hash(&columns, &rows)
}

/// The embedded asset's table facts ((row count, column names)) — the loader
/// re-checks the manifest's recorded counts against them, and the test
/// fixtures build their manifests from them (never a hard-coded count that
/// would go stale when the generator changes).
pub fn asset_table_facts(bytes: &[u8]) -> (u64, Vec<String>) {
    let (columns, rows) = parse_asset_csv(bytes);
    (rows.len() as u64, columns)
}

/// The asset CSV parse (split lines, split fields — the example assets are
/// unquoted, verified by the file-validator material check; a change that
/// breaks that assumption makes the demo refuse at boot, never mis-hash).
fn parse_asset_csv(bytes: &[u8]) -> (Vec<String>, Vec<Vec<Option<String>>>) {
    let text = std::str::from_utf8(bytes).expect("the embedded example is utf-8");
    let mut lines = text.split('\n').filter(|l| !l.is_empty());
    let columns: Vec<String> = lines
        .next()
        .expect("the example has a header line")
        .split(',')
        .map(|c| c.to_string())
        .collect();
    let rows: Vec<Vec<Option<String>>> = lines
        .map(|line| {
            line.split(',')
                .map(|field| {
                    if field.is_empty() {
                        None
                    } else {
                        Some(field.to_string())
                    }
                })
                .collect()
        })
        .collect();
    (columns, rows)
}

// ─────────────────────────────────────────────────────────────────────────────
// Path resolution
// ─────────────────────────────────────────────────────────────────────────────

/// The bundle path resolution: `TXR_DEMO_BUNDLE` > `demo.bundle_path` >
/// `<app-data-dir>/demo-bundle` (the plan's "default under the app data
/// directory, outside the repo"). The env leg is trimmed; an empty env does
/// not override (the same convention as the other `TXR_*` paths).
pub fn resolve_path(demo: &config::DemoConfig, data_root: &Path) -> PathBuf {
    if let Ok(v) = std::env::var(BUNDLE_ENV) {
        let trimmed = v.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    if !demo.bundle_path.trim().is_empty() {
        return PathBuf::from(demo.bundle_path.trim());
    }
    data_root.join(DEFAULT_BUNDLE_DIR_NAME)
}

// ─────────────────────────────────────────────────────────────────────────────
// The loader (schema + hash validation; the boot refusal's other half)
// ─────────────────────────────────────────────────────────────────────────────

/// A bundle validation failure: the message is the human line the boot
/// refusal prints (path + what is wrong + how to record a fresh bundle).
#[derive(Debug)]
pub struct BundleError {
    message: String,
}

impl BundleError {
    fn new(message: impl Into<String>) -> Self {
        Self { message: message.into() }
    }
}

impl std::fmt::Display for BundleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for BundleError {}

/// Validate one hash string: `"sha256:"` + 64 lowercase hex chars.
fn check_hash_shape(value: &str, what: &str) -> Result<(), BundleError> {
    let hexpart = value.strip_prefix("sha256:").unwrap_or("");
    if hexpart.len() != 64 || !hexpart.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(BundleError::new(format!(
            "the bundle's `{what}` is not a sha256 content hash: `{value}`"
        )));
    }
    Ok(())
}

/// One whole-bundle validation pass over the parsed manifest. `bundle_dir`
/// is the directory the manifest came from (table paths are resolved
/// against it and must stay inside it).
fn validate(bundle: &DemoBundle, bundle_dir: &Path) -> Result<(), BundleError> {
    if bundle.format != FORMAT_TAG {
        return Err(BundleError::new(format!(
            "the manifest is not a `{FORMAT_TAG}` (format `{}`)",
            bundle.format
        )));
    }
    if bundle.version != FORMAT_VERSION {
        return Err(BundleError::new(format!(
            "unsupported bundle format version {} (this build reads version {FORMAT_VERSION})",
            bundle.version
        )));
    }
    if bundle.dataset_id.trim().is_empty() {
        return Err(BundleError::new("the manifest carries no dataset id"));
    }

    // The recorded example hashes vs the embedded example assets (the loader
    // recomputes the asset hashes with the same canonical function). A
    // mismatch means the example data changed AFTER the recording — the demo
    // must refuse rather than replay predictions recorded for other tables.
    let assets = crate::modules::file_validator::assets::ASSETS;
    let es = [
        ("patients", &bundle.tables.patients),
        ("measurements", &bundle.tables.measurements),
        (
            "predict_measurements",
            &bundle.tables.predict_measurements,
        ),
    ];
    let hashes = [
        ("patients", csv_bytes_content_hash(assets.patients_example)),
        (
            "measurements",
            csv_bytes_content_hash(assets.measurements_example),
        ),
        (
            "predict_measurements",
            csv_bytes_content_hash(assets.predict_measurements_example),
        ),
    ];
    for ((name, table), (_asset_name, hash)) in es.into_iter().zip(hashes.iter()) {
        check_hash_shape(&table.content_hash, &format!("tables.{name}.content_hash"))?;
        if table.content_hash != *hash {
            return Err(BundleError::new(format!(
                "the bundle's `{name}` example table hash `{}` does not match this build's \
                 embedded example (`{hash}`) — the bundle was recorded against different \
                 example data",
                table.content_hash
            )));
        }
    }

    // The recorded row/column facts are re-checked against the assets too
    // (the hash already proves content identity; this makes a stale fact in
    // a hand-made manifest fail loudly rather than silently mis-describe).
    {
        let assets = crate::modules::file_validator::assets::ASSETS;
        let asset_facts = [
            ("patients", assets.patients_example, &bundle.tables.patients),
            ("measurements", assets.measurements_example, &bundle.tables.measurements),
            (
                "predict_measurements",
                assets.predict_measurements_example,
                &bundle.tables.predict_measurements,
            ),
        ];
        for (name, bytes, table) in asset_facts {
            let (rows, columns) = asset_table_facts(bytes);
            if table.rows != rows || table.columns != columns {
                return Err(BundleError::new(format!(
                    "the bundle's recorded `{name}` facts ({} rows, {:?}) do not match this \
                     build's embedded example ({} rows, {:?})",
                    table.rows, table.columns, rows, columns
                )));
            }
        }
    }

    // Configuration ids unique + sane day bounds.
    let mut config_ids: Vec<&str> = Vec::new();
    for cfg in &bundle.configurations {
        if cfg.id.trim().is_empty() {
            return Err(BundleError::new("a configuration record carries an empty id"));
        }
        if config_ids.contains(&cfg.id.as_str()) {
            return Err(BundleError::new(format!(
                "configuration id `{}` appears twice",
                cfg.id
            )));
        }
        config_ids.push(&cfg.id);
        if !cfg.decision_day.is_finite() || cfg.decision_day < 0.0 {
            return Err(BundleError::new(format!(
                "configuration `{}` carries an invalid decision day",
                cfg.id
            )));
        }
        if !cfg.look_ahead_day.is_finite() || cfg.look_ahead_day < 0.0 {
            return Err(BundleError::new(format!(
                "configuration `{}` carries an invalid look-ahead day",
                cfg.id
            )));
        }
    }
    if config_ids.is_empty() {
        return Err(BundleError::new("the manifest records no configuration"));
    }
    if bundle.methods.is_empty() {
        return Err(BundleError::new("the manifest records no method"));
    }

    // Every record: named configuration, sane seconds, present+parseable
    // tables with the recorded row count, reuse only with a model.
    for method in &bundle.methods {
        if method.method_id.trim().is_empty() {
            return Err(BundleError::new("a method record carries an empty id"));
        }
        for record in &method.records {
            if !config_ids.contains(&record.configuration_id.as_str()) {
                return Err(BundleError::new(format!(
                    "method `{}` records configuration `{}` which the manifest does not \
                     define",
                    method.method_id, record.configuration_id
                )));
            }
            if !record.seconds.is_finite() || record.seconds <= 0.0 {
                return Err(BundleError::new(format!(
                    "method `{}` configuration `{}` carries invalid measured seconds",
                    method.method_id, record.configuration_id
                )));
            }
            if record.reuse.is_some() && record.model.is_none() {
                return Err(BundleError::new(format!(
                    "method `{}` configuration `{}` has a reuse record without a model \
                     record (a reuse run is impossible without a model)",
                    method.method_id, record.configuration_id
                )));
            }
            validate_column(bundle_dir, method, record, &record.train)?;
            if let Some(reuse) = &record.reuse {
                validate_column(bundle_dir, method, record, reuse)?;
            }
        }
    }
    Ok(())
}

/// One prediction-column record: the referenced table exists inside the
/// bundle dir, parses with the engine's CSV codec, carries a `patient_id`
/// column and exactly the recorded row count.
fn validate_column(
    bundle_dir: &Path,
    method: &BundleMethod,
    record: &BundleMethodRecord,
    column: &BundlePredictionsColumn,
) -> Result<(), BundleError> {
    // The path must resolve INSIDE the bundle dir: an absolute path or a
    // `..` component would escape it (a manifest is data, never a path
    // authority).
    let table_path = Path::new(&column.table);
    if table_path.is_absolute()
        || table_path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(BundleError::new(format!(
            "method `{}` configuration `{}`: table path `{}` escapes the bundle directory",
            method.method_id, record.configuration_id, column.table
        )));
    }
    let path = bundle_dir.join(table_path);
    let text = std::fs::read_to_string(&path).map_err(|e| {
        BundleError::new(format!(
            "method `{}` configuration `{}`: table `{}` is unreadable: {e}",
            method.method_id, record.configuration_id, column.table
        ))
    })?;
    let table: CsvTable = parse_csv(&text).map_err(|e| {
        BundleError::new(format!(
            "method `{}` configuration `{}`: table `{}` is not a valid CSV: {}",
            method.method_id,
            record.configuration_id,
            column.table,
            e.detail()
        ))
    })?;
    if table.col("patient_id").is_none() {
        return Err(BundleError::new(format!(
            "method `{}` configuration `{}`: table `{}` has no `patient_id` column",
            method.method_id, record.configuration_id, column.table
        )));
    }
    if table.nrow() as u64 != column.rows {
        return Err(BundleError::new(format!(
            "method `{}` configuration `{}`: table `{}` carries {} rows but the manifest \
             records {}",
            method.method_id,
            record.configuration_id,
            column.table,
            table.nrow(),
            column.rows
        )));
    }
    Ok(())
}

/// Load + validate the bundle at `dir` (the boot-time half of the contract).
/// `Err` is the clear refusal message: it names the path and the recorder.
pub fn load(dir: &Path) -> Result<Arc<DemoBundle>, BundleError> {
    let manifest = dir.join(MANIFEST_FILE);
    let text = std::fs::read_to_string(&manifest).map_err(|e| {
        BundleError::new(format!(
            "the demo bundle at {} is missing or unreadable ({e}); record it with \
             scripts/demo/record-demo-bundle.py",
            dir.display()
        ))
    })?;
    let bundle: DemoBundle = serde_json::from_str(&text).map_err(|e| {
        BundleError::new(format!(
            "the demo bundle manifest at {} is not valid version-{FORMAT_VERSION} JSON: {e}; \
             record a fresh bundle with scripts/demo/record-demo-bundle.py",
            dir.display()
        ))
    })?;
    validate(&bundle, dir)?;
    Ok(Arc::new(bundle))
}

// ─────────────────────────────────────────────────────────────────────────────
// The inspect/validate example-hash guard
// ─────────────────────────────────────────────────────────────────────────────

/// The guard's table-hash membership: is `table`'s canonical content hash
/// one of `allowed` (the bundle's recorded hashes)?
fn hash_in(table: &ParsedTable, allowed: &[&str]) -> bool {
    let hash = parsed_table_hash(table);
    allowed.iter().any(|h| *h == &hash)
}

/// `POST /api/file-validation/inspect`: the request table must be the
/// collection of example tables the bundle records. The predict screen
/// inspects its one file AS kind `measurements`, so that kind admits BOTH
/// the training measurements table and the predict-measurements table; the
/// patients kind admits the patients table only. An empty bundle (desktop
/// mode) is the no-op answer the callers only reach when the demo is off.
pub fn inspect_allowed(
    bundle: Option<&DemoBundle>,
    kind: crate::modules::file_validator::types::FileTableKind,
    table: &ParsedTable,
) -> bool {
    let Some(bundle) = bundle else { return true };
    use crate::modules::file_validator::types::FileTableKind;
    let allowed: &[&str] = match kind {
        FileTableKind::Patients => &[&bundle.tables.patients.content_hash],
        FileTableKind::Measurements => &[
            &bundle.tables.measurements.content_hash,
            &bundle.tables.predict_measurements.content_hash,
        ],
    };
    hash_in(table, allowed)
}

/// `POST /api/file-validation/validate`: `files` mode requires the training
/// pair; `predict` mode the predict-measurements table. Anything else —
/// including a table the bundle does not record — is a mismatch.
pub fn validate_allowed(
    bundle: Option<&DemoBundle>,
    mode: crate::modules::file_validator::types::ValidationMode,
    patients: Option<&ParsedTable>,
    measurements: &ParsedTable,
) -> bool {
    let Some(bundle) = bundle else { return true };
    use crate::modules::file_validator::types::ValidationMode;
    match mode {
        ValidationMode::Files => {
            let Some(patients) = patients else { return false };
            hash_in(patients, &[&bundle.tables.patients.content_hash])
                && hash_in(measurements, &[&bundle.tables.measurements.content_hash])
        }
        ValidationMode::Predict => {
            hash_in(measurements, &[&bundle.tables.predict_measurements.content_hash])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hash_of(text: &str) -> String {
        format!("sha256:{}", hex::encode(Sha256::digest(text.as_bytes())))
    }

    fn table(columns: &[&str], rows: &[&[Option<&str>]]) -> ParsedTable {
        ParsedTable {
            source: crate::modules::file_validator::types::ParsedTableSource {
                name: "t.csv".to_string(),
                format: crate::modules::file_validator::types::TableFormat::Csv,
            },
            header_row: 1,
            columns: columns.iter().map(|c| c.to_string()).collect(),
            rows: rows
                .iter()
                .map(|r| r.iter().map(|c| c.map(|s| s.to_string())).collect())
                .collect(),
        }
    }

    // ── the canonical hash (the cross-language lockstep with the recorder) ──

    /// The pinned vector: trailing empty fields are dropped, `None` and `""`
    /// encode the same, and a quoted field is RFC4180-escaped. The Python
    /// recorder's unit test pins the SAME text and hash.
    #[test]
    fn canonical_hash_matches_the_recorder_vector() {
        let t = table(
            &["a", "b"],
            &[
                &[Some("x"), Some("y")],
                &[Some("1"), None],
                &[Some("2"), Some("3")],
                &[Some("with,comma"), Some("say \"hi\"")],
            ],
        );
        let text = canonical_table_text(&t.columns, &t.rows);
        assert_eq!(
            text,
            "a,b\nx,y\n1\n2,3\n\"with,comma\",\"say \"\"hi\"\"\""
        );
        let expected = hash_of(&text);
        assert_eq!(canonical_table_hash(&t.columns, &t.rows), expected);
        assert_eq!(csv_bytes_content_hash(("a,b\nx,y\n1\n2,3\n").as_bytes()), hash_of("a,b\nx,y\n1\n2,3"));
    }

    /// Padding then trimming: a reader that pads rows to the header length
    /// and one that trims trailing empty fields produce the same hash.
    #[test]
    fn canonical_hash_is_insensitive_to_trailing_empty_fields() {
        let t1 = table(&["a", "b", "c"], &[&[Some("1"), Some("2"), None]]);
        let t2 = table(&["a", "b", "c"], &[&[Some("1"), Some("2")]]);
        assert_eq!(
            canonical_table_hash(&t1.columns, &t1.rows),
            canonical_table_hash(&t2.columns, &t2.rows)
        );
        // But a MIDDLE empty field is content, not padding.
        let t3 = table(&["a", "b", "c"], &[&[Some("1"), None, Some("3")]]);
        assert_ne!(
            canonical_table_hash(&t1.columns, &t1.rows),
            canonical_table_hash(&t3.columns, &t3.rows)
        );
    }

    // ── the resolver ──

    #[test]
    fn resolve_env_wins_over_file_then_default() {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _g = LOCK.lock().unwrap();
        let demo = config::DemoConfig { bundle_path: "/from-file".to_string(), ..Default::default() };
        std::env::set_var(BUNDLE_ENV, "/from-env");
        let p = resolve_path(&demo, std::path::Path::new("/data"));
        std::env::remove_var(BUNDLE_ENV);
        assert_eq!(p, PathBuf::from("/from-env"));
        let p = resolve_path(&demo, std::path::Path::new("/data"));
        assert_eq!(p, PathBuf::from("/from-file"));
        let p = resolve_path(&config::DemoConfig::default(), std::path::Path::new("/data"));
        assert_eq!(p, PathBuf::from("/data/demo-bundle"));
    }

    #[test]
    fn empty_env_does_not_override() {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _g = LOCK.lock().unwrap();
        std::env::set_var(BUNDLE_ENV, "   ");
        let p = resolve_path(&config::DemoConfig::default(), std::path::Path::new("/data"));
        std::env::remove_var(BUNDLE_ENV);
        assert_eq!(p, PathBuf::from("/data/demo-bundle"));
    }

    // ── the guard ──

    /// A small bundle for the guard tests: the three example hashes are the
    /// REAL embedded assets' (so the guard answers exactly like boot).
    fn guard_bundle() -> DemoBundle {
        let assets = crate::modules::file_validator::assets::ASSETS;
        let facts = |bytes: &[u8]| {
            let (rows, columns) = asset_table_facts(bytes);
            (rows, columns)
        };
        let (p_rows, p_cols) = facts(assets.patients_example);
        let (m_rows, m_cols) = facts(assets.measurements_example);
        let (r_rows, r_cols) = facts(assets.predict_measurements_example);
        DemoBundle {
            format: FORMAT_TAG.to_string(),
            version: FORMAT_VERSION,
            generated_at: Utc::now(),
            dataset_id: "example".to_string(),
            tables: BundleTables {
                patients: BundleTable {
                    content_hash: csv_bytes_content_hash(assets.patients_example),
                    rows: p_rows,
                    columns: p_cols,
                },
                measurements: BundleTable {
                    content_hash: csv_bytes_content_hash(assets.measurements_example),
                    rows: m_rows,
                    columns: m_cols,
                },
                predict_measurements: BundleTable {
                    content_hash: csv_bytes_content_hash(assets.predict_measurements_example),
                    rows: r_rows,
                    columns: r_cols,
                },
            },
            configurations: Vec::new(),
            methods: Vec::new(),
        }
    }

    /// The example table helper: parse the asset bytes into a `ParsedTable`
    /// the same way the UI's viewer would (the guard compares the CONTENT,
    /// so the parse detail only has to be a faithful table).
    fn asset_table(bytes: &'static [u8], name: &str) -> ParsedTable {
        let text = std::str::from_utf8(bytes).unwrap();
        let mut lines = text.split('\n').filter(|l| !l.is_empty());
        let columns = lines.next().unwrap().split(',').map(|c| c.to_string()).collect();
        let rows = lines
            .map(|l| l.split(',').map(|c| if c.is_empty() { None } else { Some(c.to_string()) }).collect())
            .collect();
        ParsedTable {
            source: crate::modules::file_validator::types::ParsedTableSource {
                name: name.to_string(),
                format: crate::modules::file_validator::types::TableFormat::Csv,
            },
            header_row: 1,
            columns,
            rows,
        }
    }

    #[test]
    fn inspect_accepts_only_the_example_tables_of_its_kind() {
        let b = guard_bundle();
        let assets = crate::modules::file_validator::assets::ASSETS;
        let patients = asset_table(assets.patients_example, "patients");
        let measurements = asset_table(assets.measurements_example, "measurements");
        let predict = asset_table(assets.predict_measurements_example, "predict");

        use crate::modules::file_validator::types::FileTableKind;
        assert!(inspect_allowed(Some(&b), FileTableKind::Patients, &patients));
        assert!(!inspect_allowed(Some(&b), FileTableKind::Patients, &measurements));
        // The predict screen inspects its one file AS kind measurements.
        assert!(inspect_allowed(Some(&b), FileTableKind::Measurements, &measurements));
        assert!(inspect_allowed(Some(&b), FileTableKind::Measurements, &predict));
        assert!(!inspect_allowed(Some(&b), FileTableKind::Measurements, &patients));

        // A single changed value is a different table (never a prefix/loose match).
        let mut changed = patients.clone();
        changed.rows[0][1] = Some("9999".to_string());
        assert!(!inspect_allowed(Some(&b), FileTableKind::Patients, &changed));

        // Desktop (no bundle): the guard is a no-op — the handlers only call
        // it when the demo is on, and a demo boot always installs a bundle.
        assert!(inspect_allowed(None, FileTableKind::Patients, &changed));
    }

    #[test]
    fn validate_accepts_the_pair_in_files_mode_and_the_predict_table_only() {
        use crate::modules::file_validator::types::ValidationMode;
        let b = guard_bundle();
        let assets = crate::modules::file_validator::assets::ASSETS;
        let patients = asset_table(assets.patients_example, "patients");
        let measurements = asset_table(assets.measurements_example, "measurements");
        let predict = asset_table(assets.predict_measurements_example, "predict");

        assert!(validate_allowed(Some(&b), ValidationMode::Files, Some(&patients), &measurements));
        // files mode never accepts the predict table in the pair.
        assert!(!validate_allowed(Some(&b), ValidationMode::Files, Some(&patients), &predict));
        // files mode needs the patients table.
        assert!(!validate_allowed(Some(&b), ValidationMode::Files, None, &measurements));
        assert!(validate_allowed(Some(&b), ValidationMode::Predict, None, &predict));
        assert!(!validate_allowed(Some(&b), ValidationMode::Predict, None, &measurements));
        assert!(validate_allowed(None, ValidationMode::Predict, None, &predict));
    }

    // ── the loader's refusals ──

    /// A scratch dir under the session's TMPDIR (the repo's working-file
    /// rule: never /tmp; the run sets TMPDIR for every test).
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("txr-demo-bundle-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_manifest(dir: &Path, manifest: &serde_json::Value) {
        std::fs::write(
            dir.join(MANIFEST_FILE),
            serde_json::to_string_pretty(manifest).unwrap(),
        )
        .unwrap();
    }

    fn valid_manifest() -> serde_json::Value {
        let assets = crate::modules::file_validator::assets::ASSETS;
        let table_hash = |bytes: &[u8]| csv_bytes_content_hash(bytes);
        let (p_rows, p_cols) = asset_table_facts(assets.patients_example);
        let (m_rows, m_cols) = asset_table_facts(assets.measurements_example);
        let (r_rows, r_cols) = asset_table_facts(assets.predict_measurements_example);
        serde_json::json!({
            "format": FORMAT_TAG,
            "version": FORMAT_VERSION,
            "generated_at": "2026-11-14T00:00:00Z",
            "dataset_id": "example",
            "tables": {
                "patients": {"content_hash": table_hash(assets.patients_example), "rows": p_rows, "columns": p_cols},
                "measurements": {"content_hash": table_hash(assets.measurements_example), "rows": m_rows, "columns": m_cols},
                "predict_measurements": {"content_hash": table_hash(assets.predict_measurements_example), "rows": r_rows, "columns": r_cols},
            },
            "configurations": [{
                "id": "pfs_d56_h238",
                "endpoint": "pfs",
                "decision_day": 56.0,
                "look_ahead_day": 238.0,
                "covariates": false,
                "logs": [{"method_id": "kelim", "stream": "engine", "content": "started"}],
            }],
            "methods": [{
                "method_id": "kelim",
                "records": [{
                    "configuration_id": "pfs_d56_h238",
                    "seconds": 12.5,
                    "train": {
                        "table": "train/pfs_d56_h238/kelim.csv",
                        "label": "kelim",
                        "group": "kinetics",
                        "group_label": "Kinetics",
                        "task": "pfs",
                        "prob_source": "native",
                        "flat_conversion": false,
                        "coverage": {"scored": 94, "eligible": 94, "fraction": 1.0},
                        "rows": 94,
                    },
                    "model": {
                        "name": "kelim",
                        "method_version": "1.0.0",
                        "group": "kinetics",
                        "group_label": "Kinetics",
                        "task": "pfs",
                        "trained_on_patients": 94,
                        "trained_at": "2026-11-14T00:00:00Z",
                        "decision_day": 56.0,
                        "endpoint": "pfs",
                        "horizon": 238.0,
                        "size_bytes": 1024,
                        "embeds_training_data": false,
                        "own_auc": 0.71,
                        "marker_count": 3,
                        "marker_kind": "all",
                        "uses_covariates": false,
                    },
                    "reuse": {
                        "table": "reuse/pfs_d56_h238/kelim.csv",
                        "label": "kelim",
                        "group": "kinetics",
                        "group_label": "Kinetics",
                        "task": "pfs",
                        "prob_source": "native",
                        "flat_conversion": false,
                        "coverage": {"scored": 15, "eligible": 15, "fraction": 1.0},
                        "rows": 15,
                    },
                }],
            }],
        })
    }

    fn write_valid_fixture(dir: &Path) {
        write_manifest(dir, &valid_manifest());
        std::fs::create_dir_all(dir.join("train/pfs_d56_h238")).unwrap();
        std::fs::create_dir_all(dir.join("reuse/pfs_d56_h238")).unwrap();
        let train_csv: String = (0..94)
            .map(|i| format!("J{i:04},0.5,\n"))
            .collect();
        std::fs::write(
            dir.join("train/pfs_d56_h238/kelim.csv"),
            format!("patient_id,probability,note\n{train_csv}"),
        )
        .unwrap();
        let reuse_csv: String = (0..15)
            .map(|i| format!("J1{i:03},0.5,\n"))
            .collect();
        std::fs::write(
            dir.join("reuse/pfs_d56_h238/kelim.csv"),
            format!("patient_id,probability,note\n{reuse_csv}"),
        )
        .unwrap();
    }

    #[test]
    fn load_accepts_a_valid_version_1_bundle() {
        let dir = scratch("valid");
        write_valid_fixture(&dir);
        let bundle = load(&dir).expect("valid bundle loads");
        assert_eq!(bundle.methods.len(), 1);
        assert_eq!(bundle.methods[0].records[0].train.rows, 94);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_refuses_a_missing_or_unreadable_bundle_with_the_recorder_hint() {
        let dir = scratch("missing");
        let err = load(&dir).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("missing or unreadable"), "{msg}");
        assert!(msg.contains("record-demo-bundle.py"), "{msg}");
        assert!(msg.contains(&dir.display().to_string()), "{msg}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_refuses_a_wrong_format_or_version() {
        let dir = scratch("format");
        let mut m = valid_manifest();
        m["format"] = serde_json::json!("something-else");
        write_manifest(&dir, &m);
        let msg = load(&dir).unwrap_err().to_string();
        assert!(msg.contains("not a `txresbench-demo-bundle`"), "{msg}");
        let _ = std::fs::remove_dir_all(&dir);

        let dir = scratch("version");
        let mut m = valid_manifest();
        m["version"] = serde_json::json!(99);
        write_manifest(&dir, &m);
        let msg = load(&dir).unwrap_err().to_string();
        assert!(msg.contains("unsupported bundle format version 99"), "{msg}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_refuses_a_bundle_recorded_against_other_example_data() {
        let dir = scratch("hash-mismatch");
        let mut m = valid_manifest();
        m["tables"]["patients"]["content_hash"] = serde_json::json!(format!("sha256:{}", "ab".repeat(32)));
        write_manifest(&dir, &m);
        let msg = load(&dir).unwrap_err().to_string();
        assert!(msg.contains("does not match this build's embedded example"), "{msg}");
        assert!(msg.contains("recorded against different example data"), "{msg}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_refuses_a_record_for_an_undefined_configuration() {
        let dir = scratch("config");
        let mut m = valid_manifest();
        m["methods"][0]["records"][0]["configuration_id"] = serde_json::json!("nope");
        write_manifest(&dir, &m);
        let msg = load(&dir).unwrap_err().to_string();
        assert!(msg.contains("which the manifest does not define"), "{msg}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_refuses_a_missing_or_malformed_prediction_table() {
        let dir = scratch("table");
        write_manifest(&dir, &valid_manifest());
        // No train dir at all: the referenced table is missing.
        let msg = load(&dir).unwrap_err().to_string();
        assert!(msg.contains("unreadable"), "{msg}");
        let _ = std::fs::remove_dir_all(&dir);

        let dir = scratch("table2");
        write_manifest(&dir, &valid_manifest());
        std::fs::create_dir_all(dir.join("train/pfs_d56_h238")).unwrap();
        std::fs::write(dir.join("train/pfs_d56_h238/kelim.csv"), "patient_id\nJ0000\n").unwrap();
        let msg = load(&dir).unwrap_err().to_string();
        assert!(msg.contains("carries 1 rows but the manifest records 94"), "{msg}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_refuses_a_reuse_record_without_a_model_record() {
        let dir = scratch("reuse");
        let mut m = valid_manifest();
        m["methods"][0]["records"][0]["model"] = serde_json::Value::Null;
        write_manifest(&dir, &m);
        let msg = load(&dir).unwrap_err().to_string();
        assert!(msg.contains("reuse record without a model record"), "{msg}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_refuses_a_table_path_escaping_the_bundle_dir() {
        let dir = scratch("escape");
        let mut m = valid_manifest();
        m["methods"][0]["records"][0]["train"]["table"] = serde_json::json!("../outside.csv");
        write_manifest(&dir, &m);
        let msg = load(&dir).unwrap_err().to_string();
        assert!(msg.contains("escapes the bundle directory"), "{msg}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_refuses_a_table_without_a_patient_id_column() {
        let dir = scratch("noid");
        write_manifest(&dir, &valid_manifest());
        std::fs::create_dir_all(dir.join("train/pfs_d56_h238")).unwrap();
        let csv: String = (0..94).map(|_| "0.5,\n").collect();
        std::fs::write(
            dir.join("train/pfs_d56_h238/kelim.csv"),
            format!("probability,note\n{csv}"),
        )
        .unwrap();
        let msg = load(&dir).unwrap_err().to_string();
        assert!(msg.contains("has no `patient_id` column"), "{msg}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
