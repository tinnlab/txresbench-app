//! Converter registry + dispatch (ITEM-16/17/18). A datatype declares
//! `ConverterRef[]`; `run_converter` is the **synchronous in-process** dispatch,
//! serving `Host` (host-lite, no sandbox) converters. The `Sandbox` arm is NOT
//! executed here: a sandbox converter (e.g. h5ad/10x → Zarr) runs
//! **asynchronously via the on-ingest jobs pipeline** (`dataset/routes.rs::
//! maybe_autoconvert_on_ingest` → a sandbox job), so this synchronous path
//! deliberately rejects it with a typed error pointing at that pipeline. The one
//! real host-lite converter is
//! `csv/tsv → columnar-table` (DEC-9) — it emits a `{columns, rows}` JSON blob, served
//! verbatim as bytes over `GET /artifacts/{id}/data`. It used to be transcoded to a typed
//! Arrow table on the fly by `workstore::serve_core::serve_table`; artifact-model ITEM-12
//! deleted that surface under INV-1 (the server never opens a byte for meaning), so the
//! blob is now decoded by the client like every other artifact. So a csv upload becomes a
//! table artifact with no new codec dep and no sandbox.

use txresbench_core::AppError;

use super::registry::DatatypeRegistry;
use super::types::{ConverterRef, ConverterRun};

/// The bytes + typing produced by a conversion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConversionOutput {
    pub datatype: String,
    pub storage_layout: String,
    pub bytes: Vec<u8>,
}

/// Find a declared converter `from → to` across the registry's datatypes (ITEM-16).
pub fn find_converter(registry: &DatatypeRegistry, from: &str, to: &str) -> Option<ConverterRef> {
    registry
        .all()
        .into_iter()
        .flat_map(|d| d.converters.iter())
        .find(|c| c.from == from && c.to == to)
        .cloned()
}

/// Run a declared converter over `input`. Host converters run in-process; a
/// Sandbox converter is NOT run here — it executes asynchronously on the on-ingest
/// jobs pipeline (`maybe_autoconvert_on_ingest`), so this synchronous path rejects
/// it with a typed error naming that pipeline.
pub fn run_converter(converter: &ConverterRef, input: &[u8]) -> Result<ConversionOutput, AppError> {
    match converter.run {
        ConverterRun::Host => match converter.entry.as_deref() {
            Some("csv_to_columnar") => to_columnar_table(input, b',', &converter.to),
            Some("tsv_to_columnar") => to_columnar_table(input, b'\t', &converter.to),
            other => Err(AppError::bad_request(
                "UNKNOWN_HOST_CONVERTER",
                format!("no host-lite converter `{}`", other.unwrap_or("<none>")),
            )),
        },
        ConverterRun::Sandbox => Err(AppError::unprocessable_entity(
            "SANDBOX_CONVERTER_IS_ASYNC",
            format!(
                "sandbox converter `{}`→`{}` does not run on the synchronous path; it \
                 executes asynchronously via the on-ingest jobs pipeline \
                 (maybe_autoconvert_on_ingest)",
                converter.from, converter.to
            ),
        )),
    }
}

/// Host-lite `csv/tsv → columnar-table`: parse a delimited table into a `{columns, rows}`
/// JSON blob, stored and served as opaque bytes. Rows are typed to numbers when every
/// cell of a value parses, else kept as strings. NOTE: naive split — no quoted-field
/// handling (near-term, R8-minimal); a real csv codec is a later host-lite step.
fn to_columnar_table(
    input: &[u8],
    delim: u8,
    to_datatype: &str,
) -> Result<ConversionOutput, AppError> {
    let text = std::str::from_utf8(input).map_err(|e| {
        AppError::bad_request("CONVERT_NOT_UTF8", format!("input is not UTF-8: {e}"))
    })?;
    let mut lines = text.lines().filter(|l| !l.trim().is_empty());
    let header = lines
        .next()
        .ok_or_else(|| AppError::bad_request("CONVERT_EMPTY", "no header row"))?;
    let delim_ch = delim as char;
    let columns: Vec<String> = header
        .split(delim_ch)
        .map(|s| s.trim().to_string())
        .collect();

    let mut rows: Vec<Vec<serde_json::Value>> = Vec::new();
    for line in lines {
        let cells: Vec<serde_json::Value> = line
            .split(delim_ch)
            .map(|c| {
                let c = c.trim();
                if let Ok(n) = c.parse::<f64>() {
                    serde_json::Number::from_f64(n)
                        .map(serde_json::Value::Number)
                        .unwrap_or_else(|| serde_json::Value::String(c.to_string()))
                } else {
                    serde_json::Value::String(c.to_string())
                }
            })
            .collect();
        rows.push(cells);
    }

    let table = serde_json::json!({ "columns": columns, "rows": rows });
    let bytes = serde_json::to_vec(&table)
        .map_err(|e| AppError::internal_error(format!("serialize table: {e}")))?;
    Ok(ConversionOutput {
        datatype: to_datatype.to_string(),
        storage_layout: "columnar-table".to_string(),
        bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::datatype::types::ConverterRun;

    // A host-lite csv→columnar-table ConverterRef. The `to` target is an arbitrary
    // example (a still-registered tabular type); the ref is directly constructed rather
    // than looked up, so the host-lite conversion LOGIC (`run_converter` →
    // `to_columnar_table`) is exercised independently of any registry registration.
    fn csv_to_table() -> ConverterRef {
        ConverterRef {
            from: "file/csv".into(),
            to: "clustering".into(),
            run: ConverterRun::Host,
            entry: Some("csv_to_columnar".into()),
        }
    }

    // TEST-13: host-lite csv→columnar-table produces {columns, rows}; unknown pair errors.
    #[test]
    fn host_lite_csv_to_table() {
        let conv = csv_to_table();
        let out = run_converter(&conv, b"gene,logfc\nCD8A,2.5\nFOXP3,-1.0").unwrap();
        assert_eq!(out.storage_layout, "columnar-table");
        assert_eq!(out.datatype, "clustering");
        let v: serde_json::Value = serde_json::from_slice(&out.bytes).unwrap();
        assert_eq!(v["columns"], serde_json::json!(["gene", "logfc"]));
        assert_eq!(v["rows"][0][0], "CD8A");
        assert_eq!(v["rows"][0][1], 2.5);
        assert_eq!(v["rows"][1][1], -1.0);

        // Unknown host converter entry → error.
        let bad = ConverterRef {
            from: "x".into(),
            to: "y".into(),
            run: ConverterRun::Host,
            entry: Some("nope".into()),
        };
        assert!(run_converter(&bad, b"").is_err());
    }

    // TEST-13 (error branches): non-UTF-8 input and a headerless/empty body are typed 400s.
    #[test]
    fn host_lite_error_branches() {
        let conv = csv_to_table();
        // Invalid UTF-8 → CONVERT_NOT_UTF8.
        let e = run_converter(&conv, &[0xff, 0xfe, 0x00]).unwrap_err();
        assert!(format!("{e:?}").contains("CONVERT_NOT_UTF8"));
        // Empty / whitespace-only (no header row) → CONVERT_EMPTY.
        let e = run_converter(&conv, b"   \n  \n").unwrap_err();
        assert!(format!("{e:?}").contains("CONVERT_EMPTY"));
    }

    // TEST-14: the synchronous path rejects a Sandbox converter with the typed
    // async-pipeline error (the real sandbox conversion runs via on-ingest jobs).
    #[test]
    fn sandbox_arm_defers_to_jobs_pipeline() {
        // The `to:` names a datatype that is still REGISTERED. It used to name the
        // retired lossless-store type (artifact-model ITEM-38), which made this fixture
        // a live reference to a type nothing can produce — the exact vocabulary residue
        // ITEM-38 exists to clear.
        let conv = ConverterRef {
            from: "single-cell/anndata".into(),
            to: "single-cell/expression".into(),
            run: ConverterRun::Sandbox,
            entry: Some("h5ad_import".into()),
        };
        let e = run_converter(&conv, b"").unwrap_err();
        assert!(format!("{e:?}").contains("SANDBOX_CONVERTER_IS_ASYNC"));
    }
}
