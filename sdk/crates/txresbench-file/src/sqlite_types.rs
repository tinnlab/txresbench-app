//! SQLite-leg query transport types + helpers (the `sqlite-backend` variant
//! only).
//!
//! sqlx's sqlite driver has a much flatter type system than Postgres: there
//! is no array type and no jsonb type — `jsonb` lives as TEXT here (per the
//! DEC-8 type map). The query macros therefore cannot infer
//! `serde_json::Value` from a TEXT column, so the sqlite-leg SELECTs override
//! the `processing_metadata` columns with [`JsonValue<T>`] (TEXT-compatible
//! decode/encode); the query macro's generated row mapping then calls
//! `.into()` on the decoded value to fill the model field, which the concrete
//! `From` impl at the bottom provides.
//!
//! The binds in the sqlite-leg INSERT/UPDATE use `sqlx::types::Json` — the
//! driver's own JSON wrapper — and `Option` JSON binds are pre-serialized to
//! `Option<String>` so `None` stays SQL NULL (a bound `Json(None)` would store
//! the TEXT `null`, not NULL — a different row value on both engines).
//!
//! The other driver-blind surface is the `uuid[]` batch select: the `= ANY($1)`
//! binds of the baseline become JSON-array membership. Because `files.id` is a
//! 16-byte BLOB (DEC-8), the array is serialized as JSON hex strings and
//! compared through SQLite's `unhex()` (3.41+, bundled 3.46 has it) so the
//! comparison stays type-honest BLOB = BLOB — a TEXT-vs-BLOB `=` would never
//! match (the storage classes are ordered, not equal).

use serde::{Deserialize, Serialize};
use sqlx::{Decode, Encode, Sqlite};
use uuid::Uuid;

/// TEXT-column transport for a jsonb-mapped Rust value.
///
/// Serializes/deserializes the inner `T` as JSON text; the query-macro
/// generated decode's `.into()` converts it to the model field via the
/// concrete `From` impls at the bottom of this module.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(transparent)]
pub struct JsonValue<T>(pub T);

impl<T> sqlx::Type<Sqlite> for JsonValue<T> {
    fn type_info() -> sqlx::sqlite::SqliteTypeInfo {
        <str as sqlx::Type<Sqlite>>::type_info()
    }

    fn compatible(ty: &sqlx::sqlite::SqliteTypeInfo) -> bool {
        <str as sqlx::Type<Sqlite>>::compatible(ty)
    }
}

impl<'r, T> Decode<'r, Sqlite> for JsonValue<T>
where
    T: serde::de::DeserializeOwned,
{
    fn decode(value: sqlx::sqlite::SqliteValueRef<'r>) -> Result<Self, sqlx::error::BoxDynError> {
        let text = <&str as Decode<'r, Sqlite>>::decode(value)?;
        let inner = serde_json::from_str(text)?;
        Ok(JsonValue(inner))
    }
}

impl<'q, T> Encode<'q, Sqlite> for JsonValue<T>
where
    T: Serialize,
{
    fn encode_by_ref(
        &self,
        args: &mut Vec<sqlx::sqlite::SqliteArgumentValue<'q>>,
    ) -> Result<sqlx::encode::IsNull, sqlx::error::BoxDynError> {
        args.push(sqlx::sqlite::SqliteArgumentValue::Text(
            serde_json::to_string(&self.0)?.into(),
        ));
        Ok(sqlx::encode::IsNull::No)
    }
}

/// `jsonb` columns (`files.processing_metadata`,
/// `file_versions.processing_metadata`).
impl From<JsonValue<serde_json::Value>> for serde_json::Value {
    fn from(v: JsonValue<serde_json::Value>) -> Self {
        v.0
    }
}

/// Serialize a `uuid[]` batch into the JSON-hex form the sqlite-leg
/// membership predicates consume: a JSON array of 32-char lowercase hex
/// strings (the `uuid::Uuid::simple()` form), compared against the BLOB column
/// through `unhex()` (`id IN (SELECT unhex(j.value) FROM json_each($1) AS j)`).
pub fn uuid_list_json(ids: &[Uuid]) -> String {
    serde_json::to_string(
        &ids.iter()
            .map(|id| id.simple().to_string())
            .collect::<Vec<String>>(),
    )
    .expect("a Vec<String> is always JSON-serializable")
}
