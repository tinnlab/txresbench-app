//! Artifact-typing validation (ITEM-12). The WRITE-path gate P1's ingest calls
//! before a row lands: the `datatype` string must resolve in the live registry, must
//! not be abstract, its `storage_layout` must match the datatype's declared layout,
//! and its `shape` must pass the per-type shape validator. Every failure is a typed
//! 422 (a producer bug). READS stay fail-soft (DEC-2) — this is only the write path.

use txresbench_core::AppError;

use super::registry::DatatypeRegistry;

/// Validate an artifact's declared typing against the registry. `Ok(())` = the row
/// may land; `Err` is a 422 that rolls the whole ingest back.
pub fn validate_artifact_typing(
    registry: &DatatypeRegistry,
    datatype: &str,
    storage_layout: &str,
    shape: &serde_json::Value,
) -> Result<(), AppError> {
    let Some(dt) = registry.get(datatype) else {
        return Err(AppError::unprocessable_entity(
            "UNKNOWN_DATATYPE",
            format!("datatype `{datatype}` is not registered"),
        ));
    };
    if dt.is_abstract {
        return Err(AppError::unprocessable_entity(
            "ABSTRACT_DATATYPE",
            format!("datatype `{datatype}` is abstract; no artifact may be directly of it"),
        ));
    }
    let expected = dt.storage.layout.as_storage_layout();
    if storage_layout != expected {
        return Err(AppError::unprocessable_entity(
            "LAYOUT_MISMATCH",
            format!(
                "datatype `{datatype}` expects storage_layout `{expected}`, got `{storage_layout}`"
            ),
        ));
    }
    registry.validate_shape(datatype, shape).map_err(|msg| {
        AppError::unprocessable_entity("SHAPE_INVALID", format!("datatype `{datatype}`: {msg}"))
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::datatype::registry::DatatypeRegistry;

    fn reg() -> DatatypeRegistry {
        // Domain datatypes (single-cell/expression, …) are manifest-contributed now
        // → build the MERGED registry (roots ∪ contributions), as boot does.
        DatatypeRegistry::build_from_embedded().unwrap()
    }

    // TEST-11: accept valid; 422 for unknown / abstract / layout-mismatch / bad-shape.
    #[test]
    fn validate_typing_paths() {
        let r = reg();
        // Valid concrete type + matching layout + empty shape.
        assert!(validate_artifact_typing(
            &r,
            "single-cell/expression",
            "chunked-sparse",
            &serde_json::json!({})
        )
        .is_ok());
        assert!(
            validate_artifact_typing(&r, "report/html", "opaque", &serde_json::json!({})).is_ok()
        );

        // Unknown datatype.
        let e = validate_artifact_typing(&r, "bogus/type", "opaque", &serde_json::json!({}))
            .unwrap_err();
        assert!(format!("{e:?}").contains("UNKNOWN_DATATYPE"));

        // Abstract datatype rejected on an artifact.
        let e = validate_artifact_typing(&r, "matrix", "chunked-dense", &serde_json::json!({}))
            .unwrap_err();
        assert!(format!("{e:?}").contains("ABSTRACT_DATATYPE"));

        // Layout mismatch.
        let e = validate_artifact_typing(
            &r,
            "single-cell/expression",
            "columnar-table",
            &serde_json::json!({}),
        )
        .unwrap_err();
        assert!(format!("{e:?}").contains("LAYOUT_MISMATCH"));

        // Shape invalid (present-but-wrong-typed).
        let e = validate_artifact_typing(
            &r,
            "single-cell/expression",
            "chunked-sparse",
            &serde_json::json!({"cells": "x"}),
        )
        .unwrap_err();
        assert!(format!("{e:?}").contains("SHAPE_INVALID"));
    }
}
