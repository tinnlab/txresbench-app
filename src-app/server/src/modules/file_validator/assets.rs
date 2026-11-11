//! The boot-validated embedded file material (PROV-FV-6 consumed by
//! PROV-FV-4, the template/example endpoints).
//!
//! The four CSVs are generated at build time
//! (`scripts/file-validator/gen_material.py`, committed under
//! `data/file-validator/`) and embedded here with `include_bytes!`; the
//! server NEVER reads the benchmark tree at run time (INV-1) — the compiled
//! bytes are the only source, exactly like the method catalogue's embed.
//!
//! First-party-data posture (the `_checked` pattern of this framework): a file
//! the app ships that it cannot read is a BUILD failure (`include_bytes!` does
//! not compile against a missing file — the stronger of the two failures) or a
//! BOOT failure (an empty or header-broken file is refused by
//! [`ensure_checked`] in the module's `init`), never a silently empty template
//! download. The check is ONCE: [`ensure_checked`] verifies the embed at boot
//! and caches the facts; the accessors then serve the immutable bytes without
//! re-checking.

use std::fmt;
use std::sync::OnceLock;

/// The committed patients template (`patient_id,pfs_days,pfs_event,
/// os_days,os_event,age,sex,stage` — the board's C-screen column spec,
/// header row only).
pub const PATIENTS_TEMPLATE_CSV: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../data/file-validator/templates/patients.csv"
));

/// The committed measurements template (`patient_id,day,marker,value,unit` —
/// the board's measurements column spec, header row only).
pub const MEASUREMENTS_TEMPLATE_CSV: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../data/file-validator/templates/measurements.csv"
));

/// The committed patients example (the synthetic world's 300 patient rows).
pub const PATIENTS_EXAMPLE_CSV: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../data/file-validator/examples/patients.csv"
));

/// The committed measurements example (the synthetic example family's
/// training measurements — 2958 value rows).
pub const MEASUREMENTS_EXAMPLE_CSV: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../data/file-validator/examples/measurements.csv"
));

/// The committed predict-measurements example (qa-fixes3 ITEM-3's third
/// example table: the NEW patients to predict — the same markers M1/M2/M3,
/// no outcomes; the N screen's file shape).
pub const PREDICT_MEASUREMENTS_EXAMPLE_CSV: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../data/file-validator/examples/predict-measurements.csv"
));

/// The patients file's column spec (the one header every patients asset must
/// carry — templates and examples are generated from the same spec).
/// qa-fixes3 ITEM-3: the optional response columns (`responder`,
/// `response_day` — D48's "response columns are optional") joined the spec
/// because the example family carries BOTH outcomes (response + survival).
pub const PATIENTS_TEMPLATE_HEADER: &str =
    "patient_id,pfs_days,pfs_event,os_days,os_event,responder,response_day,age,sex,stage";

/// The measurements file's column spec (same header rule as above).
pub const MEASUREMENTS_TEMPLATE_HEADER: &str = "patient_id,day,marker,value,unit";

/// The six embedded CSVs as one unit (the boot check's input, and the
/// endpoint layer's byte source — PROV-FV-4 serves these bytes verbatim).
/// The sixth member is the ITEM-3 predict-measurements example.
pub struct EmbeddedAssets {
    pub patients_template: &'static [u8],
    pub measurements_template: &'static [u8],
    pub patients_example: &'static [u8],
    pub measurements_example: &'static [u8],
    pub predict_measurements_example: &'static [u8],
}

/// The embedded assets of this build (const — the include_bytes! values are
/// fixed at compile time; `include_bytes!` cannot produce a run-varying value).
pub const ASSETS: EmbeddedAssets = EmbeddedAssets {
    patients_template: PATIENTS_TEMPLATE_CSV,
    measurements_template: MEASUREMENTS_TEMPLATE_CSV,
    patients_example: PATIENTS_EXAMPLE_CSV,
    measurements_example: MEASUREMENTS_EXAMPLE_CSV,
    predict_measurements_example: PREDICT_MEASUREMENTS_EXAMPLE_CSV,
};

/// The boot-check facts of one asset (what `_checked` actually verified, so a
/// boot report can name bytes and columns).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetFact {
    pub byte_len: usize,
    /// Lines split on `\n`, with the final newline's empty tail dropped
    /// (the template files are header-only, so 1; the examples carry the
    /// source's own row counts).
    pub line_count: u32,
    /// The first line — the column spec (DEC-6: the header is row 1 in the
    /// shipped files, so header detection picks it up immediately).
    pub header_line: String,
}

/// The boot-check facts of the whole embed, one per asset.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetFacts {
    pub patients_template: AssetFact,
    pub measurements_template: AssetFact,
    pub patients_example: AssetFact,
    pub measurements_example: AssetFact,
    pub predict_measurements_example: AssetFact,
}

/// A named asset-check failure. Every variant carries the asset's name and a
/// stable code, so a boot refusal is a typed report (the first-party-data
/// posture: never degrade a broken embed into an empty template download).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AssetsError {
    /// The asset is zero-length or whitespace-only.
    Empty { name: &'static str },
    /// The first line is not the asset's declarable column spec.
    HeaderMismatch {
        name: &'static str,
        expected: &'static str,
        found: String,
    },
    /// The asset contains a NUL byte (a truncated or binary file).
    NulByte { name: &'static str },
}

impl AssetsError {
    /// The stable machine code of the failure.
    pub fn code(&self) -> &'static str {
        match self {
            AssetsError::Empty { .. } => "FILE_VALIDATOR_ASSET_EMPTY",
            AssetsError::HeaderMismatch { .. } => "FILE_VALIDATOR_ASSET_HEADER",
            AssetsError::NulByte { .. } => "FILE_VALIDATOR_ASSET_NUL",
        }
    }
}

impl fmt::Display for AssetsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AssetsError::Empty { name } => write!(
                f,
                "FILE_VALIDATOR_ASSET_EMPTY: embedded asset `{name}` is empty"
            ),
            AssetsError::HeaderMismatch {
                name,
                expected,
                found,
            } => write!(
                f,
                "FILE_VALIDATOR_ASSET_HEADER: embedded asset `{name}`'s first line is \
                 `{found}`, expected the column spec `{expected}`"
            ),
            AssetsError::NulByte { name } => write!(
                f,
                "FILE_VALIDATOR_ASSET_NUL: embedded asset `{name}` contains a NUL byte"
            ),
        }
    }
}

impl std::error::Error for AssetsError {}

/// Check ONE asset: non-empty, NUL-free, first line == the expected column
/// spec. `expected_header` is the spec constant the asset's kind declares.
/// Pure (the unit-test seam — a corrupted-byte test exercises the REAL
/// checker, not a mock).
fn check_one(
    name: &'static str,
    bytes: &[u8],
    expected_header: &'static str,
) -> Result<AssetFact, AssetsError> {
    if bytes.iter().all(|b| b.is_ascii_whitespace()) {
        return Err(AssetsError::Empty { name });
    }
    if bytes.contains(&0) {
        return Err(AssetsError::NulByte { name });
    }
    // The first line: everything up to the first `\n` (the shipped files end
    // their header line with `\n`, so the spec IS the line without it).
    let first_line_end = bytes
        .iter()
        .position(|b| *b == b'\n')
        .unwrap_or(bytes.len());
    let header_line =
        std::str::from_utf8(&bytes[..first_line_end]).map_err(|_| AssetsError::NulByte { name })?;
    if header_line != expected_header {
        return Err(AssetsError::HeaderMismatch {
            name,
            expected: expected_header,
            found: header_line.to_string(),
        });
    }
    let line_count = bytes
        .iter()
        .filter(|b| **b == b'\n')
        .count()
        .saturating_add(if bytes.last() == Some(&b'\n') { 0 } else { 1 })
        as u32;
    Ok(AssetFact {
        byte_len: bytes.len(),
        line_count,
        header_line: header_line.to_string(),
    })
}

/// The boot check over the whole embed (the REAL four files; the module's
/// `init` calls this — a failure aborts boot).
pub fn check(assets: &EmbeddedAssets) -> Result<AssetFacts, AssetsError> {
    Ok(AssetFacts {
        patients_template: check_one(
            "data/file-validator/templates/patients.csv",
            assets.patients_template,
            PATIENTS_TEMPLATE_HEADER,
        )?,
        measurements_template: check_one(
            "data/file-validator/templates/measurements.csv",
            assets.measurements_template,
            MEASUREMENTS_TEMPLATE_HEADER,
        )?,
        // The examples carry the SAME column spec as the templates (all four
        // files are generated from one board column spec, DEC-11) — the check
        // pins that agreement, so a generator change that reorders example
        // columns fails boot here, before any endpoint serves mismatched rows.
        patients_example: check_one(
            "data/file-validator/examples/patients.csv",
            assets.patients_example,
            PATIENTS_TEMPLATE_HEADER,
        )?,
        measurements_example: check_one(
            "data/file-validator/examples/measurements.csv",
            assets.measurements_example,
            MEASUREMENTS_TEMPLATE_HEADER,
        )?,
        // The predict-measurements example (ITEM-3) carries the SAME
        // measurements column spec — the predict file is the N screen's file
        // shape, so a generator change that reorders its columns fails boot
        // here too.
        predict_measurements_example: check_one(
            "data/file-validator/examples/predict-measurements.csv",
            assets.predict_measurements_example,
            MEASUREMENTS_TEMPLATE_HEADER,
        )?,
    })
}

/// The boot-validated facts, installed ONCE (the module's `init`); a second
/// caller gets the first verification's result — the embed is immutable, so
/// one check is the check.
pub fn ensure_checked() -> Result<&'static AssetFacts, AssetsError> {
    static FACTS: OnceLock<AssetFacts> = OnceLock::new();
    if let Some(f) = FACTS.get() {
        return Ok(f);
    }
    let checked = check(&ASSETS)?;
    let _ = FACTS.set(checked);
    Ok(FACTS
        .get()
        .expect("the asset facts are installed by this call or a concurrent one"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_real_embed_passes_the_boot_check_with_expected_counts() {
        let facts = check(&ASSETS).expect("the committed six CSVs must pass the boot check");
        // The board column specs (PROV-FV-4, TEST-FV-20).
        assert_eq!(
            facts.patients_template.header_line,
            PATIENTS_TEMPLATE_HEADER
        );
        assert_eq!(
            facts.measurements_template.header_line,
            MEASUREMENTS_TEMPLATE_HEADER
        );
        // Templates are header-row only (one line each); the examples carry the
        // family's own counts (100 training patients / 2959 measurement rows /
        // 269 predict rows — the ITEM-3 seeded family).
        assert_eq!(facts.patients_template.line_count, 1);
        assert_eq!(facts.measurements_template.line_count, 1);
        assert_eq!(facts.patients_example.line_count, 101);
        assert_eq!(facts.measurements_example.line_count, 2960);
        assert_eq!(facts.predict_measurements_example.line_count, 270);
        assert!(facts.patients_template.byte_len > 0);
        // The example headers agree with the template specs (the generator
        // emits one board spec for both).
        assert_eq!(facts.patients_example.header_line, PATIENTS_TEMPLATE_HEADER);
        assert_eq!(
            facts.measurements_example.header_line,
            MEASUREMENTS_TEMPLATE_HEADER
        );
        assert_eq!(
            facts.predict_measurements_example.header_line,
            MEASUREMENTS_TEMPLATE_HEADER
        );
    }

    #[test]
    fn empty_asset_is_a_named_boot_refusal() {
        let assets = EmbeddedAssets {
            patients_template: b"",
            measurements_template: MEASUREMENTS_TEMPLATE_CSV,
            patients_example: PATIENTS_EXAMPLE_CSV,
            measurements_example: MEASUREMENTS_EXAMPLE_CSV,
            predict_measurements_example: PREDICT_MEASUREMENTS_EXAMPLE_CSV,
        };
        let err = check(&assets).expect_err("an empty asset must fail the boot check");
        assert_eq!(err.code(), "FILE_VALIDATOR_ASSET_EMPTY");
        assert!(err.to_string().contains("templates/patients.csv"));
    }

    #[test]
    fn whitespace_only_asset_is_empty() {
        let assets = EmbeddedAssets {
            patients_template: b"  \n\t\n",
            measurements_template: MEASUREMENTS_TEMPLATE_CSV,
            patients_example: PATIENTS_EXAMPLE_CSV,
            measurements_example: MEASUREMENTS_EXAMPLE_CSV,
            predict_measurements_example: PREDICT_MEASUREMENTS_EXAMPLE_CSV,
        };
        assert_eq!(
            check(&assets).expect_err("must fail").code(),
            "FILE_VALIDATOR_ASSET_EMPTY"
        );
    }

    #[test]
    fn wrong_header_is_a_named_boot_refusal() {
        let assets = EmbeddedAssets {
            patients_template: b"patient_id,day\n",
            measurements_template: MEASUREMENTS_TEMPLATE_CSV,
            patients_example: PATIENTS_EXAMPLE_CSV,
            measurements_example: MEASUREMENTS_EXAMPLE_CSV,
            predict_measurements_example: PREDICT_MEASUREMENTS_EXAMPLE_CSV,
        };
        let err = check(&assets).expect_err("a broken column spec must fail the boot check");
        assert_eq!(err.code(), "FILE_VALIDATOR_ASSET_HEADER");
        match err {
            AssetsError::HeaderMismatch { expected, .. } => {
                assert_eq!(expected, PATIENTS_TEMPLATE_HEADER)
            }
            other => panic!("expected HeaderMismatch, got {other:?}"),
        }
        // The example/template header agreement is pinned too.
        let assets = EmbeddedAssets {
            patients_template: PATIENTS_TEMPLATE_CSV,
            measurements_template: MEASUREMENTS_TEMPLATE_CSV,
            patients_example: b"patient_id,day\n",
            measurements_example: MEASUREMENTS_EXAMPLE_CSV,
            predict_measurements_example: PREDICT_MEASUREMENTS_EXAMPLE_CSV,
        };
        assert_eq!(
            check(&assets).expect_err("example header mismatch").code(),
            "FILE_VALIDATOR_ASSET_HEADER"
        );
    }

    #[test]
    fn nul_byte_is_a_named_boot_refusal() {
        let assets = EmbeddedAssets {
            patients_template: PATIENTS_TEMPLATE_CSV,
            measurements_template: b"patient_id,day,marker,value,unit\n\0",
            patients_example: PATIENTS_EXAMPLE_CSV,
            measurements_example: MEASUREMENTS_EXAMPLE_CSV,
            predict_measurements_example: PREDICT_MEASUREMENTS_EXAMPLE_CSV,
        };
        assert_eq!(
            check(&assets).expect_err("a NUL byte must fail").code(),
            "FILE_VALIDATOR_ASSET_NUL"
        );
    }

    #[test]
    fn ensure_checked_is_idempotent_and_returns_the_facts() {
        let a = ensure_checked().expect("the real embed must pass");
        let b = ensure_checked().expect("second call, same facts");
        assert_eq!(a, b);
        assert_eq!(a.patients_template.byte_len, PATIENTS_TEMPLATE_CSV.len());
    }

    #[test]
    fn assets_are_the_generated_files_shapes() {
        // ASSETS is the one unit the endpoints read: every field is the
        // corresponding baked const.
        assert_eq!(ASSETS.patients_template, PATIENTS_TEMPLATE_CSV);
        assert_eq!(ASSETS.measurements_template, MEASUREMENTS_TEMPLATE_CSV);
        assert_eq!(ASSETS.patients_example, PATIENTS_EXAMPLE_CSV);
        assert_eq!(ASSETS.measurements_example, MEASUREMENTS_EXAMPLE_CSV);
        assert_eq!(
            ASSETS.predict_measurements_example,
            PREDICT_MEASUREMENTS_EXAMPLE_CSV
        );
        let pat = std::str::from_utf8(PATIENTS_TEMPLATE_CSV).expect("utf-8");
        assert!(pat.starts_with(PATIENTS_TEMPLATE_HEADER));
        assert!(pat.ends_with('\n'));
        let meas = std::str::from_utf8(MEASUREMENTS_TEMPLATE_CSV).expect("utf-8");
        assert!(meas.starts_with(MEASUREMENTS_TEMPLATE_HEADER));
        assert!(meas.ends_with('\n'));
    }
}
